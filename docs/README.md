# PrepForge documentation

[Project home](../README.md) · [Open PrepForge](https://prepforge-w0c5.onrender.com) · [繁體中文介紹](README.zh-TW.md)

## Use PrepForge

| Start here | What you will find |
| --- | --- |
| [Product introduction](../README.md) | Repertoires, training, game review, analysis, Scout and sharing |
| [Getting started](getting-started.md) | Create a repertoire, review moves and check a game |
| [繁體中文介紹](README.zh-TW.md) | 功能介紹、產品畫面與本機啟動 |

## Build and deploy

| Guide | What you will find |
| --- | --- |
| [Development](development.md) | Local setup, hot reload, checks and source layout |
| [Deployment](DEPLOYMENT.md) | Production configuration, Docker, assets, backups and monitoring |
| [Screenshot assets](assets/README.md) | Capture provenance and refresh instructions |

## Implementation

| Document | Scope |
| --- | --- |
| [Browser engines](browser-engine-migration.md) | Stockfish and Maia3 lifecycle, assets and device profiles |
| [Scout ranking](scout-production-ranking.md) | Production selection and experimental runtime boundaries |
| [Training ownership](compare-identity-boundary.md) | Personal training evidence and repertoire identity |
| [Backend consistency](backend-consistency.md) | Analysis snapshots, training transactions and sync versions |
| [Training flow and I/O](training-flow.md) | Continuous practice, deletion feedback and measured SQL work |
| [Repertoire collaboration](repertoire-collaboration.md) | Recent activity, inverse edits, position discussions and Atlas |

## Keeping documentation current

When a user-facing workflow changes, update the product descriptions in the
[English](../README.md) and [Traditional Chinese](README.zh-TW.md) introductions,
the relevant steps in [Getting started](getting-started.md), and affected
[screenshots](assets/README.md). Describe shipped behavior; keep experimental
details in their technical documents.

Update setup commands alongside `package.json`, `pyproject.toml`, CI and runtime
configuration. Verify feature claims against the implementation. A dated review
is evidence of that review's scope, not a permanent product requirement.

Archived plans, audits and finished reports live on the [`history` branch](https://github.com/unloke/prepforge/tree/history/docs/archive)
(for example the persistence reviews, operations walkthrough, playtests and issue-discovery
benchmark under [`docs/archive/2026-10-31/`](https://github.com/unloke/prepforge/tree/history/docs/archive/2026-10-31)).
