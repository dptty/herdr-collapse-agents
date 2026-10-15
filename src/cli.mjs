import { refresh, toggle } from "./commands.mjs";

const commands = { toggle, refresh };
const name = process.argv[2];
const command = commands[name];

if (!command) {
  console.error(`usage: node src/cli.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}

try {
  console.log(await command(process.env));
} catch (error) {
  console.error(`collapse-agents ${name}: ${error.message}`);
  process.exit(1);
}
