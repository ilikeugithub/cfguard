import type { Env as ExampleEnv } from "../example/src/index";

declare global {
  namespace Cloudflare {
    interface Env extends ExampleEnv {}
  }
}

export {};
