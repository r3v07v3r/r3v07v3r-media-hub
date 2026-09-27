// What the Control Centre's pipeline diagram SAYS, held against what the
// app does (renderer/components/controlcentre/pipeline.ts).
//
// The diagram is copy as much as it is data: a node's one-line detail is a
// promise about what connecting that service gets you. Two of those lines
// drifted from the code — Jellyfin advertised resume points nothing reads,
// and Prowlarr read as the thing the app searches through when all the app
// takes from it is a failing-indexer count — and the header said there was
// no Bazarr node directly above one. This pins the claims that were wrong,
// and the one structural fact the header got wrong with them.

import assert from 'node:assert/strict'

import { PIPELINE, PIPELINE_NODES } from '../src/renderer/src/components/controlcentre/pipeline'
import { DEFAULT_SERVICE_SETTINGS } from '../src/shared/ipc-types'

// Every server in ServiceSettings is drawn exactly once. A service with no
// node cannot be set up from the diagram at all, and one drawn twice is two
// panels editing the same address — the Jellyfin-under-Play mistake the
// file already records. Driven off the settings template rather than a
// list written here, so the NEXT service added fails this until it is drawn.
const serviceNodes = PIPELINE.flatMap((stage) => stage.nodes).filter(
  (node) => node.config.kind === 'service'
)
for (const service of Object.keys(DEFAULT_SERVICE_SETTINGS)) {
  const matches = serviceNodes.filter(
    (node) => node.config.kind === 'service' && node.config.service === service
  )
  assert.equal(
    matches.length,
    1,
    `expected exactly one pipeline node for service '${service}', found ${matches.length}`
  )
}

// Nothing reads Jellyfin's resume points, so the node must not offer them.
assert.doesNotMatch(PIPELINE_NODES['jellyfin-library'].node.detail, /resume/i)

// The app reads Prowlarr's indexer health and nothing else — it does not
// search through it — and the node says which.
assert.match(PIPELINE_NODES['prowlarr'].node.detail, /health/i)

console.log('pipeline copy tests passed')
