// Felles testoppsett: en ekte Postgres-motor i minnet (PGlite), og falske utgaver av Airtable og Slack.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { fraPglite } from '../src/db.js';
import { migrer, leggTilInviterte } from '../src/lagring.js';
import { lagApp } from '../src/app.js';

export const DATA = JSON.parse(readFileSync(new URL('../src/sporsmal.json', import.meta.url), 'utf8'));
export const RUNDE = DATA.runde;
export const alleSporsmal = DATA.deler.flatMap(d => d.sporsmal);
export const sporsmal = kode => alleSporsmal.find(q => q.kode === kode);

// Hver test får sin egen database. Den lukkes når testen er ferdig, ellers blir minnebruken stor.
export async function nyDb(t) {
  const db = fraPglite(new PGlite());
  await migrer(db);
  t?.after(() => db.close());
  return db;
}

export const folk = n => Array.from({ length: n }, (_, i) => ({ navn: `Person ${i + 1}`, epost: `person${i + 1}@alv.no`, slackId: i % 2 ? `U${1000 + i}` : '' }));

export function falskAirtable() {
  const mottatt = [];
  const kall = [];
  return {
    konfigurert: true, mottatt, kall, feilNeste: 0,
    async opprett(rader) {
      if (this.feilNeste > 0) { this.feilNeste--; throw new Error('Airtable svarte 503'); }
      kall.push(rader.length);
      mottatt.push(...rader);
    },
  };
}

export function falskSlack(kjente = {}) {
  const sendt = [];
  return {
    konfigurert: true, sendt, oppslag: [],
    async finnBruker(epost) { this.oppslag.push(epost); return kjente[epost] ?? null; },
    async sendDm(id, tekst) { sendt.push({ id, tekst }); },
  };
}

// Starter appen på en ledig port. klokke.naa kan flyttes for å teste før åpning, underveis og etter frist.
export async function startApp({ inviterte = folk(12), admin = ['sjef@alv.no'] } = {}) {
  const db = await nyDb();
  await leggTilInviterte(db, RUNDE, inviterte);
  const klokke = { naa: new Date('2027-01-06T10:00:00+01:00') };
  const airtable = falskAirtable();
  const slack = falskSlack({ 'person3@alv.no': 'U_OPPSLAG_3', 'sjef@alv.no': 'U_SJEF' });
  const app = lagApp({
    db, airtable, slack, logg: { error() {} }, naa: () => klokke.naa,
    konfig: { apner: '2027-01-04T07:00:00+01:00', frist: '2027-01-15T23:59:59+01:00', adminEpost: admin, lenke: 'https://halvaar.test/' },
  });
  const server = http.createServer(app.handter);
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const rot = `http://127.0.0.1:${server.address().port}`;
  async function kall(sti, { epost, kropp, hode = {} } = {}) {
    const r = await fetch(rot + sti, {
      method: kropp === undefined ? 'GET' : 'POST',
      headers: { ...(epost ? { 'X-Auth-Request-Email': epost } : {}), ...(kropp === undefined ? {} : { 'Content-Type': 'application/json', 'X-Halvaar': '1' }), ...hode },
      body: kropp === undefined ? undefined : JSON.stringify(kropp),
    });
    const tekst = await r.text();
    let data = null;
    try { data = JSON.parse(tekst); } catch {}
    return { status: r.status, data, tekst };
  }
  return { db, app, klokke, airtable, slack, kall, stopp: async () => { await new Promise(ok => server.close(ok)); await db.close(); } };
}

// Et gyldig svar med ett svar av hver type.
export const etSvar = (merke = 'x') => ({
  'SEL-02': 'Helt enig', 'OPP-06': 'Jeg er mellom oppdrag', 'KI-01': 'Mye hver dag', 'KI-05': 'Omtrent passe',
  'LON-07': sporsmal('LON-07').verdier['8'], 'EGE-01': 7, 'KI-08': 'Kommentar ' + merke,
});
