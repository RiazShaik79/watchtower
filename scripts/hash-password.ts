// `npm run hash-password`: type the admin password (not echoed); prints the scrypt hash to put in
// ADMIN_PASSWORD_HASH. The plain password is never stored or printed.
import { hashPassword } from "@/lib/password";
import { readHidden } from "./prompt";

const password = await readHidden("Admin password (min 12 characters): ");
if (password.length < 12) {
  console.error("Too short: use at least 12 characters.");
  process.exit(1);
}
console.log(`\nADMIN_PASSWORD_HASH=${await hashPassword(password)}`);
