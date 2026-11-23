import test from 'node:test';
import assert from 'node:assert/strict';
import { lagAirtable } from '../src/airtable.js';
import { lagSlack } from '../src/slack.js';
import { startApp, folk, etSvar, DATA, RUNDE, sporsmal } from './hjelp.js';

const svarKropp = merke => ({ runde: RUNDE, svar: etSvar(merke) });
const iKo = async m => (await m.db.query('SELECT count(*)::int AS n FROM svar_ko')).rows[0].n;

test('siden krever innlogging, helsesjekken gjør det ikke', async t => {
  const m = await startApp(); t.after(m.stopp);
  assert.equal((await m.kall('/healthz')).status, 200);
  assert.equal((await m.kall('/')).status, 401);
  assert.equal((await m.kall('/api/meg')).status, 401);
  const side = await m.kall('/', { epost: 'person1@alv.no' });
  assert.equal(side.status, 200);
  assert.match(side.tekst, /const DEMO = false;/);
  assert.match(side.tekst, /"runde":"2027-01"/);
  assert.match(side.tekst, /"fristTekst":"fredag 15\. januar"/);
  assert.ok(!side.tekst.includes('/*__DATA__*/null'));
  assert.equal((await m.kall('/finnes-ikke', { epost: 'person1@alv.no' })).status, 404);
});

test('status for den som åpner siden følger invitasjon, levering og tidspunkt', async t => {
  const m = await startApp(); t.after(m.stopp);
  const status = async epost => (await m.kall('/api/meg', { epost })).data.status;
  assert.equal(await status('fremmed@alv.no'), 'ikke-invitert');
  assert.equal(await status('sjef@alv.no'), 'ikke-invitert', 'admin er ikke invitert');
  m.klokke.naa = new Date('2027-01-03T12:00:00+01:00');
  assert.equal(await status('person1@alv.no'), 'ikke-apnet');
  m.klokke.naa = new Date('2027-01-04T08:00:00+01:00');
  assert.equal(await status('PERSON1@alv.no'), 'apen');
  assert.equal((await m.kall('/api/meg', { epost: 'person1@alv.no' })).data.navn, 'Person 1');
  m.klokke.naa = new Date('2027-01-16T00:00:01+01:00');
  assert.equal(await status('person1@alv.no'), 'stengt');
});

test('levering: én gang, bare når åpent, bare gyldige svar', async t => {
  const m = await startApp(); t.after(m.stopp);
  const lever = (epost, kropp = svarKropp(), hode) => m.kall('/api/svar', { epost, kropp, hode });
  assert.equal((await lever('fremmed@alv.no')).status, 403);
  assert.equal((await lever('person1@alv.no', { runde: '2026-01', svar: etSvar() })).status, 400);
  assert.equal((await lever('person1@alv.no', { runde: RUNDE, svar: { 'SEL-02': 'Tull' } })).status, 400);
  assert.equal((await lever('person1@alv.no', svarKropp(), { 'X-Halvaar': '' })).status, 400, 'uten egen header avvises innsendingen');
  assert.equal(await iKo(m), 0);

  const ok = await lever('person1@alv.no');
  assert.deepEqual([ok.status, ok.data], [200, { ok: true }]);
  assert.equal((await m.kall('/api/meg', { epost: 'person1@alv.no' })).data.status, 'levert');
  assert.equal((await lever('person1@alv.no')).status, 409);

  m.klokke.naa = new Date('2027-01-03T12:00:00+01:00');
  assert.equal((await lever('person2@alv.no')).status, 423);
  m.klokke.naa = new Date('2027-01-16T00:00:01+01:00');
  assert.equal((await lever('person2@alv.no')).status, 423);
  assert.equal(await iKo(m), 1);
});

test('admin er stengt for andre, og viser aldri hvem som har levert', async t => {
  const m = await startApp(); t.after(m.stopp);
  assert.equal((await m.kall('/admin', { epost: 'person1@alv.no' })).status, 403);
  assert.equal((await m.kall('/admin/api/status', { epost: 'person1@alv.no' })).status, 403);
  assert.equal((await m.kall('/admin/api/purr', { epost: 'person1@alv.no', kropp: { tekst: 'hei' } })).status, 403);
  assert.equal((await m.kall('/admin', { epost: 'sjef@alv.no' })).status, 200);

  await m.kall('/api/svar', { epost: 'person1@alv.no', kropp: svarKropp() });
  const status = (await m.kall('/admin/api/status', { epost: 'sjef@alv.no' })).data;
  assert.deepEqual([status.levert, status.inviterte, status.venter, status.overfort, status.fase], [1, 12, 1, 0, 'apen']);
  const liste = (await m.kall('/admin/api/inviterte', { epost: 'sjef@alv.no' })).data;
  assert.equal(liste.length, 12);
  assert.deepEqual(Object.keys(liste[0]).sort(), ['epost', 'navn', 'slackId', 'unntatt']);
});

test('admin kan legge til, unnta og fjerne inviterte', async t => {
  const m = await startApp({ inviterte: folk(2) }); t.after(m.stopp);
  const admin = (sti, kropp) => m.kall('/admin/api/' + sti, { epost: 'sjef@alv.no', kropp });
  assert.deepEqual((await admin('inviterte', { liste: [{ navn: 'Ny', epost: 'ny@alv.no', slackId: 'U9' }] })).data, { lagtTil: 1 });
  await admin('unntatt', { epost: 'ny@alv.no', unntatt: true });
  await admin('fjern', { epost: 'person2@alv.no' });
  assert.deepEqual((await admin('inviterte')).data, [
    { epost: 'ny@alv.no', navn: 'Ny', slackId: 'U9', unntatt: true },
    { epost: 'person1@alv.no', navn: 'Person 1', slackId: '', unntatt: false },
  ]);
  assert.equal((await m.kall('/api/meg', { epost: 'person2@alv.no' })).data.status, 'ikke-invitert');
});

test('purring: riktige mottakere, bolk overføres først, og svaret røper ingenting', async t => {
  const m = await startApp({ inviterte: folk(16) }); t.after(m.stopp);
  const admin = (sti, kropp) => m.kall('/admin/api/' + sti, { epost: 'sjef@alv.no', kropp });
  // Person 5–16 leverer (12 svar). Person 1–4 har ikke levert.
  for (let i = 5; i <= 16; i++) assert.equal((await m.kall('/api/svar', { epost: `person${i}@alv.no`, kropp: svarKropp(String(i)) })).status, 200);
  await admin('unntatt', { epost: 'person2@alv.no', unntatt: true });   // har ikke levert, skal ikke purres
  await admin('unntatt', { epost: 'person6@alv.no', unntatt: true });   // har levert, skal uansett ikke purres

  assert.equal((await admin('purr', { tekst: '   ' })).status, 400);
  const r = await admin('purr', { tekst: 'Husk undersøkelsen.' });
  assert.equal(r.status, 200);
  // Person 1 finnes ikke i Slack, så én utsending feiler. Svaret har likevel ingen navn og ingen antall.
  assert.deepEqual(r.data, { ok: true, noenFeilet: true, overforingFeilet: false });

  // Person 3 mangler Slack-ID og slås opp på e-post. Person 4 har ID. Person 2 er unntatt.
  assert.deepEqual(m.slack.sendt.map(s => s.id).sort(), ['U1003', 'U_OPPSLAG_3']);
  assert.ok(m.slack.sendt.every(s => s.tekst === 'Husk undersøkelsen.\nhttps://halvaar.test/'));
  assert.deepEqual(m.slack.oppslag.sort(), ['person1@alv.no', 'person3@alv.no']);

  // Tolv svar i køen: sju overføres, fem holdes igjen.
  assert.equal(m.airtable.mottatt.length, 7);
  const status = (await admin('status')).data;
  assert.deepEqual([status.levert, status.venter, status.overfort, status.purringer.length], [12, 5, 7, 1]);
});

test('purring virker bare mens undersøkelsen er åpen', async t => {
  const m = await startApp(); t.after(m.stopp);
  m.klokke.naa = new Date('2027-01-16T08:00:00+01:00');
  assert.equal((await m.kall('/admin/api/purr', { epost: 'sjef@alv.no', kropp: { tekst: 'hei' } })).status, 409);
  assert.equal(m.slack.sendt.length, 0);
});

test('slack-test og slack-sjekk', async t => {
  const m = await startApp({ inviterte: folk(4) }); t.after(m.stopp);
  const admin = (sti, kropp) => m.kall('/admin/api/' + sti, { epost: 'sjef@alv.no', kropp });
  assert.equal((await admin('slack-test', {})).status, 200);
  assert.deepEqual(m.slack.sendt.map(s => s.id), ['U_SJEF']);
  const sjekk = (await admin('slack-sjekk', {})).data;
  assert.deepEqual(sjekk.map(x => [x.epost, x.funnet]), [['person1@alv.no', false], ['person2@alv.no', true], ['person3@alv.no', true], ['person4@alv.no', true]]);
  assert.equal((await admin('inviterte')).data[2].slackId, 'U_OPPSLAG_3', 'ID-en som ble funnet, lagres');
});

test('etter fristen overføres alt, og Airtable får verken navn eller e-post', async t => {
  const m = await startApp({ inviterte: folk(8) }); t.after(m.stopp);
  for (let i = 1; i <= 7; i++) await m.kall('/api/svar', { epost: `person${i}@alv.no`, kropp: svarKropp(String(i)) });
  await m.app.tikk();
  assert.equal(m.airtable.mottatt.length, 0, 'før fristen overføres ingenting av seg selv');

  m.klokke.naa = new Date('2027-01-16T00:05:00+01:00');
  m.airtable.feilNeste = 1;
  await m.app.tikk();                                   // Airtable feiler, ingenting går tapt
  assert.equal(m.airtable.mottatt.length, 0);
  await m.app.tikk();
  await m.app.tikk();                                   // et ekstra tikk sender ikke noe på nytt
  assert.equal(m.airtable.mottatt.length, 7);

  assert.ok(!/person\d|@alv\.no|Person \d/.test(JSON.stringify(m.airtable.mottatt)), 'ingen navn eller e-postadresser i det som sendes');
  for (const rad of m.airtable.mottatt) {
    assert.ok(Object.keys(rad).every(k => /^fld[A-Za-z0-9]{14}$/.test(k)));
    assert.equal(rad[DATA.airtable.runde], '2027-01');
    assert.equal(rad[DATA.airtable.mottatt], '2027-01-15T23:05:00.000Z', 'tidsstempelet er bolkens, likt for alle');
    assert.equal(rad[sporsmal('SEL-02').feltId], 'Helt enig');
  }
  assert.deepEqual(m.airtable.mottatt.map(r => r[sporsmal('KI-08').feltId]).sort(), [1, 2, 3, 4, 5, 6, 7].map(i => 'Kommentar ' + i));
  const status = (await m.kall('/admin/api/status', { epost: 'sjef@alv.no' })).data;
  assert.deepEqual([status.levert, status.venter, status.overfort, status.fase], [7, 0, 7, 'stengt']);
});

test('Airtable-klienten sender riktig forespørsel og feiler tydelig', async () => {
  const kall = [];
  const airtable = lagAirtable({
    token: 'pat123', baseId: 'appX', tabell: 'tblY',
    fetch: async (url, valg) => { kall.push({ url, valg }); return { ok: kall.length === 1, status: 422, json: async () => ({ error: { type: 'INVALID_VALUE_FOR_COLUMN' } }) }; },
  });
  assert.equal(airtable.konfigurert, true);
  await airtable.opprett([{ fldA: 'Helt enig' }, { fldA: 'Helt uenig' }]);
  assert.equal(kall[0].url, 'https://api.airtable.com/v0/appX/tblY');
  assert.equal(kall[0].valg.headers.Authorization, 'Bearer pat123');
  assert.deepEqual(JSON.parse(kall[0].valg.body), { records: [{ fields: { fldA: 'Helt enig' } }, { fields: { fldA: 'Helt uenig' } }], typecast: false });
  await assert.rejects(airtable.opprett([{ fldA: 'x' }]), /Airtable svarte 422 INVALID_VALUE_FOR_COLUMN/);
  assert.equal(lagAirtable({ token: '', baseId: 'appX', tabell: 'tblY' }).konfigurert, false);
});

test('Slack-klienten slår opp på e-post og sender direktemelding', async () => {
  const kall = [];
  const svar = { 'users.lookupByEmail': { ok: true, user: { id: 'U42' } }, 'chat.postMessage': { ok: true } };
  const slack = lagSlack({ token: 'xoxb-1', fetch: async (url, valg) => { kall.push({ url, valg }); return { ok: true, json: async () => svar[new URL(url).pathname.split('/').pop()] }; } });
  assert.equal(await slack.finnBruker('ola@alv.no'), 'U42');
  assert.equal(kall[0].url, 'https://slack.com/api/users.lookupByEmail?email=ola%40alv.no');
  await slack.sendDm('U42', 'Hei');
  assert.deepEqual(JSON.parse(kall[1].valg.body), { channel: 'U42', text: 'Hei' });
  assert.equal(kall[1].valg.headers.Authorization, 'Bearer xoxb-1');
  svar['users.lookupByEmail'] = { ok: false, error: 'users_not_found' };
  assert.equal(await slack.finnBruker('ukjent@alv.no'), null);
  svar['chat.postMessage'] = { ok: false, error: 'channel_not_found' };
  await assert.rejects(slack.sendDm('U0', 'Hei'), /channel_not_found/);
});
