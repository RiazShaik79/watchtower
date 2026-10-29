// `npm run db:migrate`: apply pending db/migrations/*.sql (the worker and dashboard also do this on start).
import { closeDb, runMigrations } from "@/lib/db";

runMigrations()
  .then(() => console.log("Migrations up to date."))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
