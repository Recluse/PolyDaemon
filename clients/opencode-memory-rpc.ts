// Complete JSON-Schema RPC definition; no runtime SDK package is needed by the server loader.
export const ProjectMemory = {
  id: 'polydaemon.memory',
  events: {},
  methods: {
    bridge: {
      errors: {},
      input: { type: 'object', properties: { sessionID: { type: 'string' } }, required: ['sessionID'], additionalProperties: false },
      output: { type: 'object', additionalProperties: true },
    },
    status: {
      errors: {},
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'object', additionalProperties: true },
    },
  },
}
