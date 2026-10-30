# Customizing an intake

Set `ORGANIZATION_SCHEMA_PATH` to your JSON schema file and restart the server. Its root `title` supplies the church name in the public page and organization context. The bundled `fixtures/record.schema.json` is a working starting point. Missing or blank titles use `Organization`. Names are HTML escaped before rendering.

This is a deliberately limited schema subset, not a general JSON Schema validator. Invalid or unsupported schemas fail loading at startup instead of silently weakening their rules.

The root must have `type: "object"` and nonempty `properties`. Each property must explicitly use `type: "string"`, `type: "boolean"`, or one nested `type: "object"` with nonempty properties of strings or booleans. Deeper nesting and empty schemas are rejected. Property names cannot be blank, contain dots, or be `__proto__`, `prototype`, or `constructor`.

Supported validation keywords are:

- `required`: an array of unique names present in that object's properties. A nested field is required only when both its parent object and the field are required.
- `const`: a string or boolean matching the field's declared type.
- `format: "email"`: only on strings.
- `minLength`: a nonnegative integer up to 4096, only on strings. Length uses JavaScript UTF-16 code units, matching intake input validation.

String constants must be nonempty, have no leading or trailing whitespace, fit within the 4096 code-unit message limit, and satisfy their `minLength` and email constraints. Incompatible constants and minimum lengths above the message limit fail loading because no accepted answer could satisfy them.

Allowed annotations are string `title` and `description` on any node, plus string `$schema` on the root. They do not add validation. Field titles label prompts; root title identifies the church. All other keywords are rejected, including `additionalProperties`, `default`, `enum`, `pattern`, `maxLength`, `$ref`, `allOf`, and numeric bounds. Types such as number, integer, null, arrays, or unions are rejected. For example, `{ "type": "string", "pattern": "^A" }` is unsupported; `{ "type": "boolean", "const": "yes" }` is invalid because the const type differs.

Required fields are collected in schema order. Optional fields are not automatically prompted; people can supply or edit them by field name, for example `change city to Madison`. Every edit invalidates the previous confirmation. Once required details are complete, the user must confirm the displayed exact set with a whole `yes` (case insensitive, including `Yes`). `yep` and `yes please` do not finalize a record. An earlier yes while collecting fields cannot save an incomplete intake.

Draft field values persist immediately as intake progresses, before final confirmation or an agreement answer. Marking a consent field required with `const: true` gates confirmed record creation; it does not defer draft persistence. Disclose this behavior in the public page. When an optional model provider is configured, it receives the person's message (`personMessage`) for reply phrasing; deterministic schema validation and confirmation remain local.

The public renderer replaces every `{{ORGANIZATION_NAME}}` token with an escaped name. Place tokens only in HTML text or quoted attributes, never scripts or styles. There is no dynamic HTML injection.
