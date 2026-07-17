# @tinyhands/sdk

Framework-neutral remote client for Tinyhands `/v1` REST + SSE.

```ts
import { TinyhandsClient } from "@tinyhands/sdk";

const client = new TinyhandsClient({ baseUrl: "http://localhost:8787" });
const conversation = await client.conversations.create();
for await (const event of conversation.events()) console.log(event);
```

The SDK depends only on `@tinyhands/protocol`. It supports custom authorization
headers, cancellation, and persisted-event reconnection through Last-Event-ID.
