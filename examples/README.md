# Example config

`playpen.config.ts` here shows every key with a note on what it does. Copy it to
your project's root and keep the parts that apply; the rules behind each key are
in the main README under Config.

The repo's own `playpen.config.ts` adds `satisfies PlaypenConfig` with a type
import from `src/session/projectconfig.ts`, for editor help. That works inside
this repo; a copied file leaves it out.
