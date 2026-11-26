// Sender påminnelser som direktemeldinger fra en Slack-bot.
// Boten trenger disse tillatelsene: chat:write, im:write, users:read, users:read.email.

export function lagSlack({ token, fetch = globalThis.fetch }) {
  async function kall(metode, { query, body } = {}) {
    const url = 'https://slack.com/api/' + metode + (query ? '?' + new URLSearchParams(query) : '');
    const svar = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!svar.ok) throw new Error(`Slack svarte ${svar.status}`);
    return svar.json();
  }
  return {
    konfigurert: Boolean(token),
    // Slår opp Slack-brukeren fra e-postadressen. Returnerer bruker-ID, eller null hvis adressen ikke finnes i Slack.
    // Andre feil (manglende tillatelse, ugyldig token) kastes, slik at de ikke forveksles med «finnes ikke».
    async finnBruker(epost) {
      const r = await kall('users.lookupByEmail', { query: { email: epost } });
      if (r.ok) return r.user.id;
      if (r.error === 'users_not_found') return null;
      throw new Error('Slack: ' + r.error);
    },
    async sendDm(brukerId, tekst) {
      const r = await kall('chat.postMessage', { body: { channel: brukerId, text: tekst } });
      if (!r.ok) throw new Error('Slack: ' + r.error);
    },
  };
}
