// Ponto de entrada da API central no Cloudflare Workers.

import { type ApiEnv, createApi } from "./app";

const app = createApi();

export default { fetch: app.fetch } satisfies ExportedHandler<ApiEnv>;
