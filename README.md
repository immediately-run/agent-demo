# agent-demo

The **embedded-agent demo** as an [immediately.run](https://immediately.run) app
(UI_AS_APPS_SPEC §5.5 / §5.9, guarantee G12). It reads this app's **grant-filtered
method catalog** (`useCatalog()`) and treats it as an agent's tool list — then runs
a tool via `invoke()`.

The point is **confinement**: an LLM agent handed only this catalog can drive only
what the app may already do. A method *outside* the catalog, named directly, still
hits the host's §8.4 gate and returns `forbidden` — so agent sandboxing falls out
of the capability model, with no separate agent jail. The "Try spaces:share" button
demonstrates this (the app holds `spaces:app`, not `spaces:admin`).

## Develop
```sh
npm install && npm run dev
```
