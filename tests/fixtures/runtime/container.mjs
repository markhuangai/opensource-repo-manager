import { setInterval, clearInterval } from "node:timers";
import { loadProtectedConfiguration } from "/opt/orm/app/dist/config/load.js";
import { Store } from "/opt/orm/app/dist/repositories/store.js";
await loadProtectedConfiguration();
new Store("/data/state/manager.sqlite").close();
const timer = setInterval(() => {}, 1000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => clearInterval(timer));
console.log("Component fixture ready.");
