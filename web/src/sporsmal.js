// Validerer et innsendt svar mot spørsmålssettet og oversetter spørsmålskoder til felt-ID-er i Airtable.
// Bare kjente spørsmål og kjente svaralternativer slipper gjennom.

export class UgyldigSvar extends Error {}

const MAKS_TEKST = 5000;

export function lagValidator(data) {
  const kart = new Map(data.deler.flatMap(del => del.sporsmal).map(q => [q.kode, q]));
  const tillatt = q => {
    if (q.type === 'likert') return [...data.likert, ...(q.ekstra ?? [])];
    if (q.type === 'valg') return q.valg;
    if (q.type === 'skala') return [...Object.values(q.verdier), ...(q.ekstra ?? [])];
    return null;
  };
  return function valider(svar) {
    if (!svar || typeof svar !== 'object' || Array.isArray(svar)) throw new UgyldigSvar('Svarene mangler.');
    const felt = {};
    for (const [kode, verdi] of Object.entries(svar)) {
      const q = kart.get(kode);
      if (!q) throw new UgyldigSvar('Ukjent spørsmål: ' + kode);
      if (q.type === 'tekst') {
        if (typeof verdi !== 'string') throw new UgyldigSvar('Ugyldig svar på ' + kode);
        const tekst = verdi.trim();
        if (!tekst) continue;
        if (tekst.length > MAKS_TEKST) throw new UgyldigSvar('For lang tekst på ' + kode);
        felt[q.feltId] = tekst;
      } else if (q.type === 'tall') {
        if (!Number.isInteger(verdi) || verdi < 1 || verdi > 10) throw new UgyldigSvar('Ugyldig svar på ' + kode);
        felt[q.feltId] = verdi;
      } else {
        if (!tillatt(q).includes(verdi)) throw new UgyldigSvar('Ugyldig svar på ' + kode);
        felt[q.feltId] = verdi;
      }
    }
    if (!Object.keys(felt).length) throw new UgyldigSvar('Svaret er tomt.');
    felt[data.airtable.runde] = data.runde;
    return felt;
  };
}
