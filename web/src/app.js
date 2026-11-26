// HTTP-laget. Innloggingen gjøres av Halvnais foran appen, som sender e-postadressen til den
// innloggede i X-Auth-Request-Email. Appen bruker adressen til to ting: å slå opp om personen er
// invitert, og å registrere at personen har levert. Adressen lagres aldri sammen med svarene,
// sendes aldri til Airtable og skrives aldri i loggen sammen med en levering.

import { readFileSync } from 'node:fs';
import * as lagring from './lagring.js';
import { lagValidator, UgyldigSvar } from './sporsmal.js';

const les = navn => readFileSync(new URL(navn, import.meta.url), 'utf8');
// Gjør JSON trygg å legge rett inn i en <script>-blokk.
const LINJESKILLE = String.fromCharCode(0x2028), AVSNITTSSKILLE = String.fromCharCode(0x2029);
const tryggJson = verdi => JSON.stringify(verdi).replace(/</g, '\\u003c').split(LINJESKILLE).join('\\u2028').split(AVSNITTSSKILLE).join('\\u2029');

class HttpFeil extends Error {
  constructor(status, kode) { super(kode); this.status = status; this.kode = kode; }
}

export function lagApp({ db, konfig, airtable, slack, naa = () => new Date(), logg = console }) {
  const data = JSON.parse(les('./sporsmal.json'));
  const valider = lagValidator(data);
  const runde = data.runde;
  const apner = new Date(konfig.apner), frist = new Date(konfig.frist);
  if (isNaN(apner) || isNaN(frist) || apner >= frist) throw new Error('APNER og FRIST må være gyldige tidspunkter, og APNER må være før FRIST.');
  const fristTekst = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Oslo' }).format(frist);
  const side = les('./index.mal.html')
    .replace('/*__DEMO__*/true', () => 'false')
    .replace('/*__DATA__*/null', () => tryggJson({ ...data, fristTekst }));
  const adminSide = les('./admin.html');
  const standardTekst = `Hei! Halvårsundersøkelsen er åpen til ${fristTekst}, og du har ikke levert ennå. `
    + 'Svarene er anonyme. Innloggingen brukes bare til å vite hvem som skal få denne påminnelsen.';

  const fase = () => (naa() < apner ? 'ikke-apnet' : naa() > frist ? 'stengt' : 'apen');

  // Én overføring om gangen, så samme rad aldri sendes to ganger.
  let tur = Promise.resolve();
  const iTur = fn => { const p = tur.then(fn, fn); tur = p.catch(() => {}); return p; };
  const overfor = flytt => iTur(async () => {
    if (flytt) await lagring.flyttTilUtboks(db, runde, { endelig: flytt === 'endelig', naa: naa() });
    if (airtable.konfigurert) await lagring.sendUtboks(db, runde, airtable, data.airtable.mottatt);
  });

  // Kjøres hvert minutt. Etter fristen flyttes alt som er igjen, og utboksen sendes på nytt hvis noe feilet sist.
  async function tikk() {
    try {
      await overfor(fase() === 'stengt' ? 'endelig' : null);
    } catch (feil) {
      logg.error('Overføring feilet og prøves igjen:', feil.message);
    }
  }

  /* ---------- Hjelpere ---------- */
  const send = (res, status, type, kropp) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(kropp);
  };
  const json = (res, status, verdi) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(verdi));

  async function lesJson(req) {
    // Egen header og JSON-innhold kreves, slik at andre nettsteder ikke kan sende inn på vegne av en innlogget.
    if (req.headers['x-halvaar'] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpFeil(400, 'ugyldig-foresporsel');
    const biter = [];
    let lengde = 0;
    for await (const bit of req) {
      lengde += bit.length;
      if (lengde > 200_000) throw new HttpFeil(413, 'for-stor');
      biter.push(bit);
    }
    try { return JSON.parse(Buffer.concat(biter).toString('utf8')); } catch { throw new HttpFeil(400, 'ugyldig-json'); }
  }

  /* ---------- Svarsiden ---------- */
  async function meg(req, res, epost) {
    const invitert = await lagring.finnInvitert(db, runde, epost);
    // Plattformens X-Auth-Request-User er en intern ID, ikke et navn. Derfor vises e-postadressen for dem som ikke står på listen.
    const navn = invitert?.navn || epost;
    json(res, 200, { navn, status: !invitert ? 'ikke-invitert' : invitert.harLevert ? 'levert' : fase() });
  }

  async function svar(req, res, epost) {
    const kropp = await lesJson(req);
    if (kropp?.runde !== runde) throw new HttpFeil(400, 'feil-runde');
    const invitert = await lagring.finnInvitert(db, runde, epost);
    if (!invitert) throw new HttpFeil(403, 'ikke-invitert');
    if (invitert.harLevert) throw new HttpFeil(409, 'allerede-levert');
    if (fase() !== 'apen') throw new HttpFeil(423, 'stengt');
    let felt;
    try { felt = valider(kropp.svar); } catch (feil) {
      if (feil instanceof UgyldigSvar) throw new HttpFeil(400, 'ugyldig-svar');
      throw feil;
    }
    const resultat = await lagring.lever(db, runde, epost, felt);
    if (resultat === 'allerede-levert') throw new HttpFeil(409, 'allerede-levert');
    if (resultat === 'ikke-invitert') throw new HttpFeil(403, 'ikke-invitert');
    json(res, 200, { ok: true });
  }

  /* ---------- Admin ---------- */
  async function finnSlackId(person) {
    if (person.slackId) return person.slackId;
    const id = await slack.finnBruker(person.epost);
    if (id) await lagring.settSlackId(db, runde, person.epost, id);
    return id;
  }

  const admin = {
    'GET /admin/api/status': async (req, res) => json(res, 200, {
      ...(await lagring.status(db, runde)), runde, fase: fase(), apner: apner.toISOString(), frist: frist.toISOString(),
      fristTekst, standardTekst, lenke: konfig.lenke, slackKlar: slack.konfigurert, airtableKlar: airtable.konfigurert,
    }),
    'GET /admin/api/inviterte': async (req, res) => json(res, 200, await lagring.listInviterte(db, runde)),
    'POST /admin/api/inviterte': async (req, res) => {
      const { liste } = await lesJson(req);
      if (!Array.isArray(liste) || liste.length > 500) throw new HttpFeil(400, 'ugyldig-liste');
      json(res, 200, { lagtTil: await lagring.leggTilInviterte(db, runde, liste) });
    },
    'POST /admin/api/unntatt': async (req, res) => {
      const { epost, unntatt } = await lesJson(req);
      await lagring.settUnntatt(db, runde, epost, unntatt);
      json(res, 200, { ok: true });
    },
    'POST /admin/api/fjern': async (req, res) => {
      const { epost } = await lesJson(req);
      await lagring.fjernInvitert(db, runde, epost);
      json(res, 200, { ok: true });
    },
    // Sjekker Slack-koblingen for ALLE inviterte, uavhengig av om de har levert.
    'POST /admin/api/slack-sjekk': async (req, res) => {
      await lesJson(req);
      if (!slack.konfigurert) throw new HttpFeil(409, 'slack-mangler');
      const ut = [];
      for (const person of await lagring.listInviterte(db, runde)) {
        let funnet = false;
        try { funnet = Boolean(await finnSlackId(person)); } catch {}
        ut.push({ epost: person.epost, navn: person.navn, funnet });
      }
      json(res, 200, ut);
    },
    'POST /admin/api/slack-test': async (req, res, epost) => {
      await lesJson(req);
      if (!slack.konfigurert) throw new HttpFeil(409, 'slack-mangler');
      const id = await slack.finnBruker(epost);
      if (!id) throw new HttpFeil(404, 'fant-ikke-deg-i-slack');
      await slack.sendDm(id, 'Test fra svarsiden for halvårsundersøkelsen. Slack-koblingen virker.');
      json(res, 200, { ok: true });
    },
    // Sender påminnelser etter at admin har godkjent teksten. Svaret sier aldri hvem eller hvor mange
    // som fikk påminnelse. Det ville røpet om en person på unntakslisten har levert.
    'POST /admin/api/purr': async (req, res) => {
      const { tekst } = await lesJson(req);
      if (!slack.konfigurert) throw new HttpFeil(409, 'slack-mangler');
      if (fase() !== 'apen') throw new HttpFeil(409, 'ikke-apen');
      if (typeof tekst !== 'string' || !tekst.trim() || tekst.length > 2000) throw new HttpFeil(400, 'ugyldig-tekst');
      let overforingFeilet = false;
      try { await overfor('bolk'); } catch (feil) { overforingFeilet = true; logg.error('Overføring før purring feilet og prøves igjen:', feil.message); }
      let noenFeilet = false;
      const melding = tekst.trim() + (konfig.lenke ? '\n' + konfig.lenke : '');
      for (const person of await lagring.mottakereAvPurring(db, runde)) {
        try {
          const id = await finnSlackId(person);
          if (!id) throw new Error('fant ikke bruker');
          await slack.sendDm(id, melding);
        } catch { noenFeilet = true; }
      }
      await lagring.loggPurring(db, runde, naa());
      json(res, 200, { ok: true, noenFeilet, overforingFeilet });
    },
  };

  /* ---------- Ruting ---------- */
  async function handter(req, res) {
    const sti = new URL(req.url, 'http://lokal').pathname;
    try {
      if (sti === '/healthz' || sti === '/readyz') return send(res, 200, 'text/plain; charset=utf-8', 'ok');
      const epost = lagring.normaliserEpost(req.headers['x-auth-request-email'] || konfig.devEpost);
      if (!epost) throw new HttpFeil(401, 'ikke-innlogget');
      if (req.method === 'GET' && sti === '/') return send(res, 200, 'text/html; charset=utf-8', side);
      if (req.method === 'GET' && sti === '/api/meg') return await meg(req, res, epost);
      if (req.method === 'POST' && sti === '/api/svar') return await svar(req, res, epost);
      if (sti === '/admin' || sti.startsWith('/admin/')) {
        if (!konfig.adminEpost.includes(epost)) throw new HttpFeil(403, 'ikke-admin');
        if (req.method === 'GET' && (sti === '/admin' || sti === '/admin/')) return send(res, 200, 'text/html; charset=utf-8', adminSide);
        const rute = admin[req.method + ' ' + sti];
        if (rute) return await rute(req, res, epost);
      }
      throw new HttpFeil(404, 'finnes-ikke');
    } catch (feil) {
      if (feil instanceof HttpFeil) return json(res, feil.status, { feil: feil.kode });
      logg.error('Uventet feil på', req.method, sti, '-', feil.message);
      if (!res.headersSent) json(res, 500, { feil: 'serverfeil' });
    }
  }

  return { handter, tikk, runde, fase };
}
