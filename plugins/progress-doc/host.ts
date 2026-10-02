// bb-plugin-progress-doc — host entry, run by the daemon on the machine that
// holds the thread's workspace.
import { homedir } from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";
import { listMarkdown, readDoc, resolvePath } from "./lib/host-files";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    resolvePath: async (input) => resolvePath(input, homedir()),
    listMarkdown: (input) => listMarkdown(input, homedir()),
    readDoc: (input) => readDoc(input, homedir()),
  },
});
