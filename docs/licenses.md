# Licenses and attribution

Project code is provided under the root [MIT license](../LICENSE). REUSE metadata in [REUSE.toml](../REUSE.toml) applies the repository's existing `2026 the contributors` attribution; this records the declared license rather than independently establishing authorship. Contributors must have the right to submit their work and preserve upstream attribution.

The [Contributor Covenant 3.0 code of conduct](../CODE_OF_CONDUCT.md) is adapted from the Organization for Ethical Source's official text and retains its separate **CC-BY-SA-4.0** license and attribution. It is not relicensed as MIT. Full license texts are in [LICENSES](../LICENSES/).

## Locked npm dependencies

| Package | Locked version | Use | License |
| --- | --- | --- | --- |
| `@types/node` | 24.19.2 | Direct development dependency | MIT |
| `typescript` | 5.9.3 | Direct development dependency | Apache-2.0 |
| `undici-types` | 7.24.6 | Transitive development dependency of `@types/node` | MIT |

There are no production npm dependencies. `package-lock.json` is authoritative for the dependency versions and integrity hashes; update this inventory when the lockfile changes. Dependencies keep their own licenses, including the TypeScript Apache-2.0 grant. Preserve their supplied license files and TypeScript's `ThirdPartyNoticeText.txt` if redistributing the installed compiler. Its embedded-material notices include DefinitelyTyped, Unicode, DOM/W3C, WHATWG, Web Background Synchronization, and WebGL. The project does not vendor these development packages in source control.

Optional `openclaw/imsg` is a separate executable installed by the operator. It is spawned through its RPC interface rather than copied into this repository; upstream declares MIT. Verify the selected binary's source, version and license when installing it. Future adapters listed in the README are unimplemented interfaces, not installed dependencies or vendored code.

## Checking license metadata

With the REUSE tool installed, run:

```sh
uv tool run --from 'reuse[charset-normalizer]==6.3.0' reuse lint
```

The encoding extra is needed on hosts where the tool cannot otherwise identify file encodings. This is developer tooling, not a runtime dependency. Add a specific REUSE annotation and the corresponding license text when introducing material under different terms; never cover third-party code with the default project annotation by accident.
