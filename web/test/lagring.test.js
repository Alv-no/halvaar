import test from 'node:test';
import assert from 'node:assert/strict';
import * as lagring from '../src/lagring.js';
import { nyDb, folk, falskAirtable, RUNDE } from './hjelp.js';

const kolonner = async (db, tabell) => (await db.query(
  'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position', [tabell])).rows.map(r => r.column_name);
const antall = async (db, tabell) => (await db.query(`SELECT count(*)::int AS n FROM ${tabell}`)).rows[0].n;

test('levering registreres én gang per invitert', async t => {
  const db = await nyDb(t);
  await lagring.leggTilInviterte(db, RUNDE, folk(3));
  assert.equal(await lagring.lever(db, RUNDE, 'Person1@ALV.no ', { a: 1 }), 'ok');
  assert.equal(await lagring.lever(db, RUNDE, 'person1@alv.no', { a: 2 }), 'allerede-levert');
  assert.equal(await lagring.lever(db, RUNDE, 'fremmed@alv.no', { a: 3 }), 'ikke-invitert');
  await lagring.fjernInvitert(db, RUNDE, 'person2@alv.no');
  assert.equal(await lagring.lever(db, RUNDE, 'person2@alv.no', { a: 4 }), 'ikke-invitert');
  assert.deepEqual((await db.query('SELECT innhold FROM svar_ko')).rows.map(r => r.innhold), [{ a: 1 }]);
  assert.deepEqual(await lagring.finnInvitert(db, RUNDE, 'person1@alv.no'), { navn: 'Person 1', harLevert: true });
});

test('svartabellene har ingen kolonne for person eller for når det ble levert', async t => {
  const db = await nyDb(t);
  assert.deepEqual(await kolonner(db, 'svar_ko'), ['id', 'runde', 'innhold']);
  assert.deepEqual(await kolonner(db, 'utboks'), ['id', 'runde', 'innhold', 'bolk']);
  assert.deepEqual(await kolonner(db, 'inviterte'), ['runde', 'epost', 'navn', 'slack_id', 'unntatt', 'fjernet', 'har_levert']);
  assert.deepEqual(await kolonner(db, 'purringer'), ['id', 'runde', 'sendt']);
});

test('interne transaksjons-ID-er kan ikke koble person og svar', async t => {
  const db = await nyDb(t);
  await lagring.leggTilInviterte(db, RUNDE, folk(8));
  for (let i = 1; i <= 6; i++) await lagring.lever(db, RUNDE, `person${i}@alv.no`, { nr: i });
  const svarXmin = new Set((await db.query('SELECT xmin::text AS x FROM svar_ko')).rows.map(r => r.x));
  const folkXmin = new Set((await db.query('SELECT xmin::text AS x FROM inviterte')).rows.map(r => r.x));
  assert.equal(svarXmin.size, 1, 'alle svar skal ha samme transaksjons-ID');
  assert.equal(folkXmin.size, 1, 'alle inviterte skal ha samme transaksjons-ID');
});

test('køen ligger i tilfeldig rekkefølge, ikke i leveringsrekkefølge', async () => {
  const plasser = new Set();
  for (let forsok = 0; forsok < 25; forsok++) {
    const db = await nyDb();
    await lagring.leggTilInviterte(db, RUNDE, folk(4));
    for (let i = 1; i <= 4; i++) await lagring.lever(db, RUNDE, `person${i}@alv.no`, { nr: i });
    plasser.add((await db.query('SELECT innhold FROM svar_ko')).rows.map(r => r.innhold.nr).indexOf(1));
    await db.close();
  }
  assert.ok(plasser.size > 1, 'det første svaret skal ikke alltid ligge på samme plass');
});

test('før fristen holdes fem svar igjen, og små bolker sendes ikke', async t => {
  const db = await nyDb(t);
  await lagring.leggTilInviterte(db, RUNDE, folk(20));
  for (let i = 1; i <= 9; i++) await lagring.lever(db, RUNDE, `person${i}@alv.no`, { nr: i });
  assert.equal(await lagring.flyttTilUtboks(db, RUNDE, { endelig: false }), 0, 'ni svar gir for liten bolk');
  for (let i = 10; i <= 12; i++) await lagring.lever(db, RUNDE, `person${i}@alv.no`, { nr: i });
  assert.equal(await lagring.flyttTilUtboks(db, RUNDE, { endelig: false }), 7);
  assert.equal(await antall(db, 'svar_ko'), lagring.MIN_BOLK);
  assert.equal(await lagring.flyttTilUtboks(db, RUNDE, { endelig: true }), 5, 'etter fristen flyttes resten');
  assert.equal(await antall(db, 'utboks'), 12);
});

test('utboksen sendes ti om gangen og aldri to ganger', async t => {
  const db = await nyDb(t);
  await lagring.leggTilInviterte(db, RUNDE, folk(23));
  for (let i = 1; i <= 23; i++) await lagring.lever(db, RUNDE, `person${i}@alv.no`, { nr: i });
  await lagring.flyttTilUtboks(db, RUNDE, { endelig: true, naa: new Date('2027-01-16T00:01:00Z') });
  const airtable = falskAirtable();
  const opprett = airtable.opprett.bind(airtable);
  let n = 0;
  airtable.opprett = async rader => { if (++n === 2) throw new Error('Airtable svarte 503'); return opprett(rader); };
  // Første forsøk: én bolk går gjennom, så feiler Airtable.
  await assert.rejects(lagring.sendUtboks(db, RUNDE, airtable, 'fldMOTTATT'));
  let s = await lagring.status(db, RUNDE);
  assert.deepEqual([s.overfort, s.venter], [10, 13]);
  // Andre forsøk sender bare resten.
  await lagring.sendUtboks(db, RUNDE, airtable, 'fldMOTTATT');
  assert.deepEqual(airtable.kall, [10, 10, 3]);
  assert.deepEqual(airtable.mottatt.map(r => r.nr).sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i + 1));
  assert.ok(airtable.mottatt.every(r => r.fldMOTTATT === '2027-01-16T00:01:00.000Z'), 'alle rader får bolkens tidspunkt');
  s = await lagring.status(db, RUNDE);
  assert.deepEqual([s.levert, s.venter, s.overfort], [23, 0, 23]);
});

test('antall leverte endrer seg ikke når en invitert fjernes', async t => {
  const db = await nyDb(t);
  await lagring.leggTilInviterte(db, RUNDE, folk(5));
  await lagring.lever(db, RUNDE, 'person1@alv.no', { nr: 1 });
  await lagring.lever(db, RUNDE, 'person2@alv.no', { nr: 2 });
  await lagring.fjernInvitert(db, RUNDE, 'person1@alv.no');   // har levert
  let s = await lagring.status(db, RUNDE);
  assert.deepEqual([s.levert, s.inviterte], [2, 4]);
  await lagring.fjernInvitert(db, RUNDE, 'person3@alv.no');   // har ikke levert
  s = await lagring.status(db, RUNDE);
  assert.deepEqual([s.levert, s.inviterte], [2, 3]);
});

test('en som fjernes og legges til igjen kan ikke levere på nytt', async t => {
  const db = await nyDb(t);
  await lagring.leggTilInviterte(db, RUNDE, [{ navn: 'Ola', epost: ' Ola@Alv.no ', slackId: 'U1' }, { navn: 'Ugyldig', epost: 'ikke-epost' }]);
  assert.deepEqual(await lagring.listInviterte(db, RUNDE), [{ epost: 'ola@alv.no', navn: 'Ola', slackId: 'U1', unntatt: false }]);
  await lagring.lever(db, RUNDE, 'ola@alv.no', { nr: 1 });
  await lagring.fjernInvitert(db, RUNDE, 'ola@alv.no');
  assert.deepEqual(await lagring.listInviterte(db, RUNDE), []);
  await lagring.leggTilInviterte(db, RUNDE, [{ navn: 'Ola N', epost: 'ola@alv.no' }]);
  assert.deepEqual(await lagring.listInviterte(db, RUNDE), [{ epost: 'ola@alv.no', navn: 'Ola N', slackId: 'U1', unntatt: false }]);
  assert.equal(await lagring.lever(db, RUNDE, 'ola@alv.no', { nr: 2 }), 'allerede-levert');
});

test('purring går bare til dem som ikke har levert og ikke er unntatt', async t => {
  const db = await nyDb(t);
  await lagring.leggTilInviterte(db, RUNDE, folk(5));
  await lagring.lever(db, RUNDE, 'person1@alv.no', { nr: 1 });
  await lagring.settUnntatt(db, RUNDE, 'person2@alv.no', true);
  await lagring.fjernInvitert(db, RUNDE, 'person3@alv.no');
  assert.deepEqual((await lagring.mottakereAvPurring(db, RUNDE)).map(p => p.epost).sort(), ['person4@alv.no', 'person5@alv.no']);
});
