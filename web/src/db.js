// Tynn databaseadapter. Samme grensesnitt for pg (drift) og PGlite (test),
// slik at all lagringslogikk testes mot en ekte Postgres-motor.

export function fraPg(pool) {
  return {
    query: (tekst, verdier) => pool.query(tekst, verdier),
    async tx(fn) {
      const klient = await pool.connect();
      try {
        await klient.query('BEGIN');
        const resultat = await fn({ query: (tekst, verdier) => klient.query(tekst, verdier) });
        await klient.query('COMMIT');
        return resultat;
      } catch (feil) {
        await klient.query('ROLLBACK').catch(() => {});
        throw feil;
      } finally {
        klient.release();
      }
    },
    close: () => pool.end(),
  };
}

export function fraPglite(pglite) {
  return {
    query: (tekst, verdier) => pglite.query(tekst, verdier),
    tx: fn => pglite.transaction(tx => fn({ query: (tekst, verdier) => tx.query(tekst, verdier) })),
    close: () => pglite.close(),
  };
}
