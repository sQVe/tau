# Rules

The stomme binary generates this file from its rule catalog. Do not edit it. Checker and fixture
paths are relative to the stomme crate.

| ID | Rule | Owner | Applies | `stomme.toml` fields | Checker | Fixtures | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `no-stomme` | The project has a `stomme.toml`. | common | always | none | src/check.rs | tests/fixtures/rules/no-stomme | enforced |
| `broken-installation` | `stomme.toml` is a regular file of valid TOML that matches the schema, selects a valid layer set, and has a closed module table. | common | `stomme.toml` exists | `schema`, `version`, `language`, `layers`, `roles`, `violations`, `modules` | src/check.rs | tests/fixtures/rules/broken-installation | enforced |
| `role-name` | Every role name in `[roles]` is one of the shared roles. | common | `stomme.toml` is valid | `roles` | src/check/roles.rs | tests/fixtures/rules/role-name | enforced |
| `role-path` | Every role path is a relative folder inside the project. | common | `stomme.toml` is valid | `roles` | src/check/roles.rs | tests/fixtures/rules/role-path | enforced |
| `role-folder` | A role folder is named after the role or ends with `-<role>`. | common | `stomme.toml` is valid | `roles` | src/check/roles.rs | tests/fixtures/rules/role-folder | enforced |
| `violation-stale` | Every entry in `[[violations]]` matches a reported problem. | common | `stomme.toml` is valid | `violations` | src/check/violations.rs | tests/fixtures/rules/violation-stale | enforced |
| `violation-growth` | `[[violations]]` does not grow against the target branch. | common | `stomme.toml` is valid and has entries | `violations` | src/check/violations.rs | tests/fixtures/rules/violation-growth | enforced |
| `weakened-test` | A change adds no test skip or lint suppression and deletes no test case against the target branch. | common | `stomme.toml` is valid | none | src/check/weakened.rs | tests/fixtures/rules/weakened-test | enforced |
| `required-part` | Every required file exists. | common | always | none | src/check/required_parts.rs | tests/fixtures/rules/required-part | enforced |
| `synced-files` | `docs/stomme/` equals the owned set, and its record matches the files and the version. | common | `stomme.toml` is valid | `version`, `language`, `layers` | src/check/synced_files.rs | tests/fixtures/rules/synced-files | enforced |
| `agents-block` | `AGENTS.md` holds the managed block between its markers, and its record matches the block. | common | `AGENTS.md` exists | `version`, `language`, `layers` | src/check/synced_files.rs | tests/fixtures/rules/agents-block | enforced |
| `package-pin` | A shared package in the root `package.json` matches the pinned version. | common | the root `package.json` exists | none | src/check/package_pins.rs | tests/fixtures/rules/package-pin | enforced |
| `workflow-pin` | A call to a reusable stomme workflow pins a release commit with the `stomme.toml` version as a `# v<version>` comment. | common | `stomme.toml` is valid | `version` | src/check/workflow_pins.rs | tests/fixtures/rules/workflow-pin | enforced |
| `layer-declared` | A project lists the layer of each framework it uses, so removing a layer cannot switch its rules off. | common | the project uses a framework that has a layer | `layers` | src/check/layer_use.rs | tests/fixtures/rules/layer-declared | partial; not enforced: framework use without a `gpui` or `gpui-component` package in `Cargo.lock`, a `react` dependency or `pi` field in the root `package.json`, or a Herdr `mod.json` beside `main.ts` |
| `tau-full-check` | `.pi/tau.json` names the full check as a non-empty `fullCheck.argv` of strings. | common | `.pi/tau.json` exists | none | src/check/required_parts.rs | tests/fixtures/rules/tau-full-check | enforced |
| `adr-file-name` | An ADR file is named `NNNN-slug.md` with a non-empty slug. | common | `docs/adr/README.md` exists | none | src/check/adr_index.rs | tests/fixtures/rules/adr-file-name | enforced |
| `adr-duplicate-number` | No two ADR files share a number. | common | `docs/adr/README.md` exists | none | src/check/adr_index.rs | tests/fixtures/rules/adr-duplicate-number | enforced |
| `adr-heading` | An ADR's first heading is `# ADR NNNN: Title` with its own number, indented by at most 3 spaces. | common | `docs/adr/README.md` exists | none | src/check/adr_index.rs | tests/fixtures/rules/adr-heading | enforced |
| `adr-retired-number` | No ADR file uses a number from the Retired table. | common | `docs/adr/README.md` exists | none | src/check/adr_index.rs | tests/fixtures/rules/adr-retired-number | enforced |
| `adr-index-count` | The ADR index lists each ADR file once. | common | `docs/adr/README.md` exists | none | src/check/adr_index.rs | tests/fixtures/rules/adr-index-count | enforced |
| `adr-index-label` | An ADR index entry's label is the ADR's number and title. | common | `docs/adr/README.md` exists | none | src/check/adr_index.rs | tests/fixtures/rules/adr-index-label | enforced |
| `adr-index-missing-file` | Every file the ADR index lists exists. | common | `docs/adr/README.md` exists | none | src/check/adr_index.rs | tests/fixtures/rules/adr-index-missing-file | enforced |
| `adr-index-entry` | Every link line in the ADR index is a `-`, `*`, or `+` list entry `[NNNN: Title](./NNNN-slug.md)`. | common | `docs/adr/README.md` exists | none | src/check/adr_index.rs | tests/fixtures/rules/adr-index-entry | enforced |
| `rust-config-file` | The root `Cargo.toml` exists, and every Cargo manifest and `.clippy.toml` or `clippy.toml` the checks read is valid. | rust | always | none | src/check/cargo_manifest.rs | tests/fixtures/rules/rust-config-file | enforced |
| `rust-lint-level` | `[workspace.lints]` keeps every shared lint at its shared priority and at least its shared level. | rust | always | none | src/check/rust_lints.rs | tests/fixtures/rules/rust-lint-level | enforced |
| `rust-lint-inheritance` | Every workspace member has `[lints] workspace = true`. | rust | always | none | src/check/rust_members.rs | tests/fixtures/rules/rust-lint-inheritance | enforced |
| `rust-required-ban` | `.clippy.toml` or `clippy.toml` holds each shared Rust `disallowed-methods` ban with its reason; `.clippy.toml` wins when both exist. | rust | always | none | none | none | guidance only |
| `rust-file-case` | A Rust file name is snake_case. | rust | always | none | src/check/layout/rust.rs | tests/fixtures/rules/rust-file-case | enforced |
| `rust-catch-all-name` | A Rust file or folder is not named after a catch-all, and no file is `mod.rs`. | rust | always | none | src/check/layout/rust.rs | tests/fixtures/rules/rust-catch-all-name | enforced |
| `rust-owner-folder` | A file that shares an owner's noun sits in the owner's folder. | rust | always | none | src/check/layout/rust.rs | tests/fixtures/rules/rust-owner-folder | enforced |
| `rust-test-placement` | A Rust unit test lives in a `#[cfg(test)] mod tests` in the owning file, not below `src`. | rust | always | none | src/check/layout/rust.rs | tests/fixtures/rules/rust-test-placement | enforced |
| `gpui-required-ban` | `.clippy.toml` or `clippy.toml` holds each GPUI `disallowed-methods` ban with its reason; `.clippy.toml` wins when both exist. | layer `gpui` | always | none | none | none | guidance only |
| `module-imports` | Imports follow the module table: a module imports only the modules its row allows. | common | the project has a module table | `modules` | src/check/modules.rs, ../../packages/imports/src/rules/moduleBoundaries.ts | tests/fixtures/rules/module-imports, ../../packages/imports/src/rules/moduleBoundaries.test.ts | enforced; TypeScript module table recorded but not checked |
| `module-listed` | Every source file belongs to a module in the module table. | common | the project has a module table | `modules` | src/check/modules.rs, ../../packages/imports/src/rules/moduleBoundaries.ts | tests/fixtures/rules/module-listed, ../../packages/imports/src/rules/moduleBoundaries.test.ts | enforced; TypeScript module table recorded but not checked |
| `module-table-order` | Module registries and their lists are sorted and free of duplicates. | typescript | the project has a module table | none | none | none | project-local |
| `module-table-documented` | The import table in the module ADR equals the enforced module table. | typescript | the project has a module table | none | none | none | project-local |
| `module-private-file` | Other modules use a folder module through its entry or public files only. | common | the project has a module table | `modules` | src/check/modules.rs, ../../packages/imports/src/rules/moduleBoundaries.ts | tests/fixtures/rules/module-private-file, ../../packages/imports/src/rules/moduleBoundaries.test.ts | enforced; TypeScript module table recorded but not checked |
| `composition-root-import` | No module imports the composition root. | typescript | the project has a composition root | none | none | none | project-local |
| `extension-isolation` | An extension does not import another extension. | typescript | the project has extensions | none | none | none | project-local |
| `extension-direction` | A shared module does not import an extension. | typescript | the project has extensions | none | none | none | project-local |
| `literal-import` | A dynamic import names a literal path, not a computed one. | typescript | the project has a module table | `modules` | ../../packages/imports/src/rules/moduleBoundaries.ts | ../../packages/imports/src/rules/moduleBoundaries.test.ts | TypeScript module table recorded but not checked |
| `crate-root-path` | A module uses other modules through their module paths, not items at the crate root. | rust | the project has a module table | `modules` | src/check/modules.rs | tests/fixtures/rules/crate-root-path | enforced |
| `pure-dependencies` | A module uses only pure modules; no module uses an I/O module. | rust | the project has a module table | none | none | none | project-local |
| `pure-std-io` | A pure module reaches no I/O through `std`, such as `std::fs` or `std::time::SystemTime::now`. | rust | the project has a module table | none | none | none | project-local |
| `pure-module-effects` | A registered pure module performs no reads or effects and imports only types and other pure modules. | typescript | the project registers pure modules | none | none | none | project-local |
| `typescript-file-case` | A TypeScript file name is camelCase, or PascalCase for a file that exports one class. | typescript | always | none | src/check/layout/typescript.rs | tests/fixtures/rules/typescript-file-case | enforced |
| `typescript-catch-all-name` | A TypeScript file or folder is not named after a catch-all. | typescript | always | none | src/check/layout/typescript.rs | tests/fixtures/rules/typescript-catch-all-name | enforced |
| `typescript-owner-folder` | A file that shares an owner's noun sits in the owner's folder. | typescript | always | none | src/check/layout/typescript.rs | tests/fixtures/rules/typescript-owner-folder | enforced |
| `no-index-file` | Source folders hold no index files. | typescript | always | none | src/check/layout/typescript.rs | tests/fixtures/rules/no-index-file | enforced |
| `one-file-folder` | A module with one production source file is a flat file, not a folder. | typescript | always | none | none | none | project-local |
| `folder-module-entry` | A folder module has an entry file named after its folder. | typescript | always | none | none | none | project-local |
| `test-file-name` | A source test file is named after a module beside it. | typescript | always | none | src/check/layout/typescript.rs | tests/fixtures/rules/test-file-name | partial; not enforced: a test path without a `src` part and a `.spec.` test |
| `fixture-import` | Production code does not load fixtures. | typescript | always | none | none | none | project-local |
| `versioned-record` | A versioned record format has a version literal and current, newer, and malformed fixtures. | typescript | the project writes versioned records | none | none | none | project-local |
| `test-project` | Every test file belongs to exactly one test project. | typescript | the project splits tests into projects | none | none | none | project-local |
| `test-environment` | The cached test tasks declare every environment variable that test code reads. | typescript | the project caches test tasks | none | none | none | project-local |
| `gpui-plain-core` | The `core` and `cli` role packages depend on no GPUI package and no `ui`, `kit`, or `app` role package, directly or through other packages. | layer `gpui` | the project has a `core` or `cli` role | `roles` | src/check/package_boundaries.rs | tests/fixtures/rules/gpui-plain-core | partial; not enforced: the plain project data that the `core` and `cli` roles pass at their boundaries |
| `gpui-app-lifetime` | One module of the `app` role owns the GPUI application, windows, tasks, and one shutdown path. | layer `gpui` | the project has an `app` role | `roles` | none | none | guidance only |
| `gpui-context-names` | Name a GPUI context `cx` and a window `window`, with `window` before `cx`. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-builder-chain` | Write an element builder as one fluent chain, with `.when_some(...)` for an optional child. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-builder-size` | Do not split a builder chain only to meet size review signals. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-element-id` | Element IDs come from stable domain data, never a list index. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-update-closure` | Inside `entity.update`, use the closure's `state` and `cx`. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-reentrant-update` | Never read or update an entity through its handle while it is being updated. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-weak-parent` | A child refers to its parent through a `WeakEntity` and treats a failed upgrade as normal. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-pure-render` | `render` starts no work, subscribes to nothing, and changes no state. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-notify` | Call `cx.notify()` once after a visible change, never from `render`. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-task-owner` | Await a `Task`, store it in its owner, or detach it on purpose. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-subscription-owner` | Store a `Subscription` in its owner, or detach it on purpose. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-no-discard-binding` | Never bind a `Task` or `Subscription` with `let _ =`. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-stale-result` | Drop a background result when the state it started from is no longer current. | layer `gpui` | always | none | none | none | guidance only |
| `gpui-component-kit` | Only the `kit` role imports gpui-component; other code uses the project's own widget types. | layer `gpui-component` | always | `roles` | src/check/package_boundaries.rs | tests/fixtures/rules/gpui-component-kit | partial; not enforced: components that a package other than `kit` uses through a bundle crate that re-exports them |
| `react-jsx-extension` | Only a file that contains JSX uses `.tsx`. | layer `react` | always | none | none | none | guidance only |
| `react-component-file` | A file that mainly exports one component is named after it in PascalCase. | layer `react` | always | none | src/check/layout/react.rs | tests/fixtures/rules/react-component-file | partial; not enforced: a PascalCase file that is not named after the component it exports |
| `react-test-placement` | A `.tsx` unit test sits beside its owner as `<owner>.test.tsx`. | layer `react` | always | none | src/check/layout/react.rs | tests/fixtures/rules/react-test-placement | enforced |
| `pi-discovered-path` | `package.json` declares every path Pi discovers, and renaming code keeps those paths. | layer `pi` | always | none | none | none | guidance only |
| `pi-registered-name` | Renaming code keeps every name registered with Pi. | layer `pi` | always | none | none | none | guidance only |
| `herdr-mod-bundle` | Each mod builds into one `main.js` bundle; imports of Herdr's own modules stay imports. | layer `herdr` | always | none | none | none | guidance only |
| `herdr-mod-files` | A mod keeps the fixed names `main.js` and `mod.json`, and its install script copies every file Herdr needs at run time. | layer `herdr` | always | none | none | none | guidance only |
| `herdr-declarations` | Mods typecheck against declarations that the pinned Herdr generates, and the repository never commits them. | layer `herdr` | always | none | none | none | guidance only |
