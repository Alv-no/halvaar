import test from 'node:test';
import assert from 'node:assert/strict';
import { lagValidator, UgyldigSvar } from '../src/sporsmal.js';
import { DATA, alleSporsmal, sporsmal, etSvar } from './hjelp.js';

const valider = lagValidator(DATA);

test('spørsmålssettet har 67 spørsmål med unike felt-ID-er', () => {
  assert.equal(alleSporsmal.length, 67);
  assert.equal(new Set(alleSporsmal.map(q => q.kode)).size, 67);
  assert.equal(new Set(alleSporsmal.map(q => q.feltId)).size, 67);
  assert.ok(alleSporsmal.every(q => /^fld[A-Za-z0-9]{14}$/.test(q.feltId)));
  assert.equal(alleSporsmal.filter(q => q.type === 'tekst').length, 11);
  assert.ok(DATA.deler.every(d => d.sporsmal.some(q => q.type === 'tekst')), 'alle deler har et fritekstfelt');
});

test('koder oversettes til felt-ID-er, og runden legges på', () => {
  const felt = valider(etSvar());
  assert.equal(felt[sporsmal('SEL-02').feltId], 'Helt enig');
  assert.equal(felt[sporsmal('OPP-06').feltId], 'Jeg er mellom oppdrag');
  assert.equal(felt[sporsmal('KI-01').feltId], 'Mye hver dag');
  assert.equal(felt[sporsmal('LON-07').feltId], '8');
  assert.equal(felt[sporsmal('EGE-01').feltId], 7);
  assert.equal(felt[sporsmal('KI-08').feltId], 'Kommentar x');
  assert.equal(felt[DATA.airtable.runde], '2027-01');
  assert.equal(Object.keys(felt).length, 8);
  assert.ok(Object.keys(felt).every(k => k.startsWith('fld')), 'bare felt-ID-er, ingen koder eller navn');
});

test('hvert spørsmål godtar alle sine egne alternativer', () => {
  for (const q of alleSporsmal) {
    const verdier = q.type === 'likert' ? [...DATA.likert, ...(q.ekstra ?? [])]
      : q.type === 'valg' ? q.valg
      : q.type === 'skala' ? [...Object.values(q.verdier), ...(q.ekstra ?? [])]
      : q.type === 'tall' ? [1, 10] : ['tekst'];
    for (const v of verdier) assert.equal(valider({ [q.kode]: v })[q.feltId], v, q.kode);
  }
});

test('ugyldige svar avvises', () => {
  const feil = svar => assert.throws(() => valider(svar), UgyldigSvar);
  feil(null);
  feil([]);
  feil({});
  feil({ 'FINNES-IKKE': 'Helt enig' });
  feil({ 'SEL-02': 'Ganske enig' });
  feil({ 'SEL-02': 'Jeg er mellom oppdrag' });     // alternativet finnes bare på andre spørsmål
  feil({ 'KI-01': 'Jeg er mellom oppdrag' });      // alternativet er fjernet fra dette spørsmålet
  feil({ 'EGE-01': 11 });
  feil({ 'EGE-01': '7' });
  feil({ 'EGE-01': 7.5 });
  feil({ 'KI-08': 42 });
  feil({ 'KI-08': 'x'.repeat(5001) });
  feil({ 'KI-08': '   ' });                           // bare blanke tegn gir et tomt svar
});

test('tekst trimmes, og tomme tekstfelt hoppes over', () => {
  const felt = valider({ 'SEL-02': 'Helt uenig', 'KI-08': '  hei  ', 'APN-01': '' });
  assert.equal(felt[sporsmal('KI-08').feltId], 'hei');
  assert.ok(!(sporsmal('APN-01').feltId in felt));
});
