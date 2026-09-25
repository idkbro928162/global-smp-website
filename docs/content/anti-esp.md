# Anti ESP — draft product copy

Draft text for the Anti ESP product in the staff CMS (Staff → Products →
Anti ESP). The website does not read this file; paste the fields in.

Everything here is limited to what is known today: the product is in
development, and its purpose and design principle are decided. It makes no
claims about supported versions, platforms, performance, effectiveness or
bypass resistance. Update it when those facts exist.

## Fields

| Field              | Value                                                             |
| ------------------ | ----------------------------------------------------------------- |
| Name               | Anti ESP                                                          |
| URL slug           | anti-esp                                                          |
| Visibility         | Published (or Draft until you want it listed)                     |
| Availability       | In development                                                    |
| Artwork            | None (the neutral placeholder is shown until real artwork exists) |
| Minecraft versions | Leave empty until verified                                        |
| Platforms          | Leave empty until verified                                        |
| Java version       | Leave empty until verified                                        |
| BuiltByBit listing | Leave empty until the listing exists                              |
| First released     | Leave empty until the first public release                        |
| Features           | Leave empty until features are implemented and tested             |

### Short description

```text
A server-side plugin in development that limits what information reaches the client, to counter ESP, x-ray and freecam-style cheats.
```

### Full description (Markdown)

```markdown
Anti ESP is a Based Productions plugin **in development**. It is being built to protect Minecraft servers against information-based cheats: player ESP, item ESP, x-ray, freecam and similar ways of reading information that a client should not have.

### The approach

Rather than sending the client everything and relying on detecting whether a cheat misuses it, Anti ESP starts from a different principle: information a player should not have should not be sent to an untrusted client in the first place. The plugin is being designed to control what the server sends, including fake or obfuscated state where appropriate.

### Planned areas of protection

- Player ESP
- Item ESP
- X-ray
- Freecam and similar client-side information gathering

These are design goals, not a list of finished features.

### Current status

Anti ESP has not been released. Supported Minecraft versions, server software, configuration and performance characteristics have not been finalised; they will be published with the first release.
```
