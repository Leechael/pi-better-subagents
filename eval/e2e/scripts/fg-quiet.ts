/** (b) A foreground command that finishes within budget: inline result, no wake. */
import { call, type FauxScript, say } from "../faux-dsl.ts";

const script: FauxScript = {
  steps: [call("bash", { command: "echo fg-quick-4410" }), say("Done.")],
};
export default script;
