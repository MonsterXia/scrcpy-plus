import { randomUUID } from 'node:crypto'
import { AutomationFault } from '../../../common/automation/protocol'

import { validArtifact } from '../../../common/automation/wire'

export function workspaceArtifact(mimeType: string, bytes: Uint8Array, metadata = {}) {
  const artifact = { artifactId: randomUUID(), mimeType, byteLength: bytes.byteLength, ...metadata }
  if (!validArtifact(artifact, bytes.byteLength))
    throw new AutomationFault('UNAVAILABLE', 'Device artifact exceeds its size limit or is invalid')
  return { artifact, bytes }
}
