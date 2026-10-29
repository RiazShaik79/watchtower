// `npm run seed`: replay the fixtures through the real pipeline into the database, marked as
// seeded (own fingerprint namespace and settings, so they never mix with real incidents).
// Resets earlier seed data first; `--no-reset` runs again on top to show that nothing is stored twice.
import { EXPECTED, seedInto } from "@/fixtures";
import { audit } from "@/lib/audit";
import { closeDb, dbStore, deleteSeededData, listIncidents, runMigrations } from "@/lib/db";

async function main() {
  await runMigrations();
  const reset = !process.argv.includes("--no-reset");
  const store = dbStore({ seeded: true });
  if (reset) {
    const removed = await deleteSeededData();
    console.log(`Removed earlier seed data: ${removed.incidents} incidents, ${removed.events} events.`);
  }
  const result = await seedInto(store);
  await audit(store, { actor: "system", action: "seed", outcome: "ok", detail: { ...result, reset } });
  console.log(`Stored ${result.stored} events (${result.duplicates} duplicates skipped), ${result.incidents} new incidents.`);

  const seeded = (await listIncidents("open")).filter((i) => i.seeded);
  console.log("\nSeeded incidents:");
  for (const i of seeded) console.log(`  ${i.severity.padEnd(8)} ${i.kind.padEnd(10)} x${String(i.eventCount).padEnd(3)} ${i.title.slice(0, 90)}`);
  const missing = EXPECTED.filter((e) => !seeded.some((i) => i.title.includes(e.titleIncludes) && i.severity === e.severity && i.kind === e.kind && i.eventCount === e.events));
  console.log(missing.length ? `\nMISMATCH: ${missing.map((m) => m.titleIncludes).join("; ")}` : `\nAll ${EXPECTED.length} expected incidents present with the right severity.`);
  process.exitCode = missing.length ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
