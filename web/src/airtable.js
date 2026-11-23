// Skriver rader til Airtable. Radene inneholder bare svarene, rundenavnet og tidspunktet for bolken.

export function lagAirtable({ token, baseId, tabell, fetch = globalThis.fetch }) {
  return {
    konfigurert: Boolean(token && baseId && tabell),
    async opprett(rader) {
      const svar = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tabell)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: rader.map(fields => ({ fields })), typecast: false }),
      });
      if (!svar.ok) {
        // Logg bare feiltypen, aldri innholdet i svarene.
        let type = '';
        try { type = (await svar.json())?.error?.type ?? ''; } catch {}
        throw new Error(`Airtable svarte ${svar.status} ${type}`.trim());
      }
    },
  };
}
