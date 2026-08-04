# @pipeworx/nih-reporter

NIH RePORTER MCP — every NIH-funded grant, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `search_grants(query?, pi_name?, organization?, fiscal_year?, state?, ic?, limit?, offset?)` — filter projects.
- `get_project(appl_id)` — full record by application ID.
- `search_publications(pmids?, appl_ids?, core_project_nums?, limit?, offset?)` — grant-linked publications.

## Data source

`https://api.reporter.nih.gov/v2/` — public POST-JSON API, no key required.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nih-reporter": {
      "url": "https://gateway.pipeworx.io/nih-reporter/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Nih Reporter data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
