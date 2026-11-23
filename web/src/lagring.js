// All lagring. Kjerneregelen: hvem som har levert og hva som er svart, ligger i hver sin tabell
// uten noe som kobler dem. Ingen felles nøkkel, ingen tidsstempler, og ingen rekkefølge som kan leses ut.
//
//   inviterte  hvem som er invitert, og om de har levert (ja/nei, uten tidspunkt)
//   svar_ko    leverte svar som venter på overføring (uten navn, e-post eller tidspunkt)
//   utboks     svar som er plukket ut til en bolk og er på vei til Airtable
//   tellere    hvor mange svar som er overført
//   purringer  når det er sendt påminnelser (uten mottakere)

import { randomInt, randomUUID } from 'node:crypto';

const LAAS = 7301;            // én levering eller overføring om gangen
export const MIN_BOLK = 5;    // så mange svar holdes igjen ved en overføring før fristen

export function stokk(liste) {
  const kopi = [...liste];
  for (let i = kopi.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [kopi[i], kopi[j]] = [kopi[j], kopi[i]];
  }
  return kopi;
}

export const normaliserEpost = epost => String(epost ?? '').trim().toLowerCase();

export async function migrer(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS inviterte (
    runde text NOT NULL,
    epost text NOT NULL,
    navn text NOT NULL DEFAULT '',
    slack_id text,
    unntatt boolean NOT NULL DEFAULT false,
    fjernet boolean NOT NULL DEFAULT false,
    har_levert boolean NOT NULL DEFAULT false,
    PRIMARY KEY (runde, epost))`);
  await db.query(`CREATE TABLE IF NOT EXISTS svar_ko (
    id uuid PRIMARY KEY,
    runde text NOT NULL,
    innhold jsonb NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS utboks (
    id uuid PRIMARY KEY,
    runde text NOT NULL,
    innhold jsonb NOT NULL,
    bolk timestamptz NOT NULL)`);
  await db.query(`CREATE TABLE IF NOT EXISTS tellere (
    runde text PRIMARY KEY,
    overfort integer NOT NULL DEFAULT 0)`);
  await db.query(`CREATE TABLE IF NOT EXISTS purringer (
    id bigserial PRIMARY KEY,
    runde text NOT NULL,
    sendt timestamptz NOT NULL DEFAULT now())`);
}

/* ---------- Levering ---------- */

// Registrerer at personen har levert, og legger svaret i køen. Alt skjer i én transaksjon:
// enten lagres begge deler, eller ingen. For at transaksjonen ikke skal bli en kobling mellom
// person og svar, skrives hele køen og hele deltakerlisten på nytt hver gang, køen i tilfeldig
// rekkefølge. Da har alle rader i begge tabeller samme interne transaksjons-ID etter hver levering.
// Returnerer 'ok', 'allerede-levert' eller 'ikke-invitert'.
export async function lever(db, runde, epost, innhold) {
  return db.tx(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [LAAS]);
    const krav = await tx.query(
      `UPDATE inviterte SET har_levert = true
        WHERE runde = $1 AND epost = $2 AND NOT fjernet AND NOT har_levert RETURNING 1 AS ok`,
      [runde, normaliserEpost(epost)]);
    if (!krav.rows.length) {
      const finnes = await tx.query('SELECT 1 FROM inviterte WHERE runde = $1 AND epost = $2 AND NOT fjernet', [runde, normaliserEpost(epost)]);
      return finnes.rows.length ? 'allerede-levert' : 'ikke-invitert';
    }
    const ko = await tx.query('SELECT innhold FROM svar_ko WHERE runde = $1', [runde]);
    const alle = stokk([...ko.rows.map(rad => rad.innhold), innhold]);
    await tx.query('DELETE FROM svar_ko WHERE runde = $1', [runde]);
    for (const ett of alle) {
      await tx.query('INSERT INTO svar_ko (id, runde, innhold) VALUES ($1, $2, $3::jsonb)', [randomUUID(), runde, JSON.stringify(ett)]);
    }
    await tx.query('UPDATE inviterte SET har_levert = har_levert WHERE runde = $1', [runde]);
    return 'ok';
  });
}

/* ---------- Overføring ---------- */

// Plukker ut en bolk fra køen og legger den i utboksen. Før fristen holdes MIN_BOLK tilfeldige
// svar igjen, og ingenting flyttes med mindre bolken blir på minst MIN_BOLK. Da kan verken en
// tidlig eller en sen bolk bestå av bare ett eller to svar. Etter fristen (endelig) flyttes alt.
// Returnerer antall svar som ble flyttet.
export async function flyttTilUtboks(db, runde, { endelig, naa = new Date() }) {
  return db.tx(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [LAAS]);
    const ko = await tx.query('SELECT id, innhold FROM svar_ko WHERE runde = $1', [runde]);
    const antallIKo = ko.rows.length;
    const antall = endelig ? antallIKo : (antallIKo >= 2 * MIN_BOLK ? antallIKo - MIN_BOLK : 0);
    if (!antall) return 0;
    const bolk = naa.toISOString();
    for (const rad of stokk(ko.rows).slice(0, antall)) {
      await tx.query('DELETE FROM svar_ko WHERE id = $1', [rad.id]);
      await tx.query('INSERT INTO utboks (id, runde, innhold, bolk) VALUES ($1, $2, $3::jsonb, $4)', [randomUUID(), runde, JSON.stringify(rad.innhold), bolk]);
    }
    return antall;
  });
}

// Sender utboksen til Airtable, ti rader om gangen. En rad slettes først når Airtable har
// bekreftet den, så en feil underveis gjør bare at resten blir liggende til neste forsøk.
export async function sendUtboks(db, runde, airtable, mottattFelt) {
  let sendt = 0;
  for (;;) {
    const rader = (await db.query('SELECT id, innhold, bolk FROM utboks WHERE runde = $1 LIMIT 10', [runde])).rows;
    if (!rader.length) return sendt;
    await airtable.opprett(rader.map(rad => ({ ...rad.innhold, [mottattFelt]: new Date(rad.bolk).toISOString() })));
    await db.tx(async tx => {
      for (const rad of rader) await tx.query('DELETE FROM utboks WHERE id = $1', [rad.id]);
      await tx.query(
        `INSERT INTO tellere (runde, overfort) VALUES ($1, $2)
         ON CONFLICT (runde) DO UPDATE SET overfort = tellere.overfort + EXCLUDED.overfort`,
        [runde, rader.length]);
    });
    sendt += rader.length;
  }
}

/* ---------- Status og admin ---------- */

const antall = async (db, sql, runde) => Number((await db.query(sql, [runde])).rows[0].n);

// Tallene admin får se. «levert» telles fra svarene, ikke fra deltakerlisten, slik at tallet
// ikke endrer seg når noen fjernes fra listen. Ellers ville det røpet om den som ble fjernet hadde levert.
export async function status(db, runde) {
  const iKo = await antall(db, 'SELECT count(*) AS n FROM svar_ko WHERE runde = $1', runde);
  const iUtboks = await antall(db, 'SELECT count(*) AS n FROM utboks WHERE runde = $1', runde);
  const overfort = await antall(db, 'SELECT coalesce(sum(overfort), 0) AS n FROM tellere WHERE runde = $1', runde);
  const inviterte = await antall(db, 'SELECT count(*) AS n FROM inviterte WHERE runde = $1 AND NOT fjernet', runde);
  const purringer = (await db.query('SELECT sendt FROM purringer WHERE runde = $1 ORDER BY sendt', [runde])).rows.map(rad => new Date(rad.sendt).toISOString());
  return { inviterte, levert: iKo + iUtboks + overfort, venter: iKo + iUtboks, overfort, purringer };
}

export async function finnInvitert(db, runde, epost) {
  const rad = (await db.query('SELECT navn, har_levert FROM inviterte WHERE runde = $1 AND epost = $2 AND NOT fjernet', [runde, normaliserEpost(epost)])).rows[0];
  return rad ? { navn: rad.navn, harLevert: rad.har_levert } : null;
}

// Listen admin ser. Den inneholder aldri om noen har levert.
export async function listInviterte(db, runde) {
  const rader = (await db.query('SELECT epost, navn, slack_id, unntatt FROM inviterte WHERE runde = $1 AND NOT fjernet ORDER BY navn, epost', [runde])).rows;
  return rader.map(rad => ({ epost: rad.epost, navn: rad.navn, slackId: rad.slack_id ?? '', unntatt: rad.unntatt }));
}

// Legger til eller oppdaterer inviterte. En som er fjernet og legges til igjen, beholder
// leveringsstatusen sin og kan derfor ikke levere to ganger.
export async function leggTilInviterte(db, runde, liste) {
  let n = 0;
  for (const person of liste) {
    const epost = normaliserEpost(person.epost);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(epost)) continue;
    await db.query(
      `INSERT INTO inviterte (runde, epost, navn, slack_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (runde, epost) DO UPDATE SET navn = EXCLUDED.navn, slack_id = coalesce(EXCLUDED.slack_id, inviterte.slack_id), fjernet = false`,
      [runde, epost, String(person.navn ?? '').trim(), String(person.slackId ?? '').trim() || null]);
    n++;
  }
  return n;
}

export const settUnntatt = (db, runde, epost, unntatt) =>
  db.query('UPDATE inviterte SET unntatt = $3 WHERE runde = $1 AND epost = $2', [runde, normaliserEpost(epost), !!unntatt]);

export const fjernInvitert = (db, runde, epost) =>
  db.query('UPDATE inviterte SET fjernet = true WHERE runde = $1 AND epost = $2', [runde, normaliserEpost(epost)]);

export const settSlackId = (db, runde, epost, slackId) =>
  db.query('UPDATE inviterte SET slack_id = $3 WHERE runde = $1 AND epost = $2', [runde, normaliserEpost(epost), slackId]);

// Hvem som skal purres: ikke levert, ikke unntatt, ikke fjernet. Brukes bare internt ved utsending
// og sendes aldri til nettleseren.
export async function mottakereAvPurring(db, runde) {
  return (await db.query('SELECT epost, navn, slack_id FROM inviterte WHERE runde = $1 AND NOT har_levert AND NOT unntatt AND NOT fjernet', [runde])).rows
    .map(rad => ({ epost: rad.epost, navn: rad.navn, slackId: rad.slack_id ?? '' }));
}

export const loggPurring = (db, runde, naa = new Date()) =>
  db.query('INSERT INTO purringer (runde, sendt) VALUES ($1, $2)', [runde, naa.toISOString()]);
