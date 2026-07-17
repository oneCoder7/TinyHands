# @tinyhands/server

Framework-neutral Tinyhands server library.

```ts
import { createTinyhandsHost } from "@tinyhands/server";
import { createTinyhandsFetchHandler } from "@tinyhands/server/http";
```

The root entry exposes `TinyhandsHost`, `ConversationService`, stable options,
DTO types, and typed application errors. The `./http` entry exposes the WHATWG
`Request`/`Response` handler for `/v1` REST + SSE.

The package does not read environment variables, bind a port, install signal
handlers, or depend on a particular web framework. See the repository README
for a complete embedding example.
