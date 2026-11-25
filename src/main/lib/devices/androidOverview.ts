import type { Adb } from '@yume-chan/adb'
import { readAndroidShell as read } from './androidShell'

export async function readAndroidOverview(adb: Adb) {
  const properties: Record<string, string> = {}
  for (const line of (await read(adb, 'getprop')).split('\n')) {
    const match = line.match(/^\[([^\]]+)\]: \[(.*)\]\s*$/)
    if (match) properties[match[1]] = match[2]
  }
  const kernelVersion = (await read(adb, 'uname -r')).trim()
  const screen = await read(adb, 'wm size')
  const memory = await read(adb, 'cat /proc/meminfo')
  const version = properties['ro.build.version.release'], sdk = properties['ro.build.version.sdk']
  const memTotal = Number(memory.match(/^MemTotal:\s*(\d+)\s+kB/m)?.[1]) * 1024
  return {
    name: properties['ro.product.model'] || '', brand: properties['ro.product.brand'] || '',
    model: properties['ro.product.model'] || '', abi: properties['ro.product.cpu.abilist'] || properties['ro.product.cpu.abi'] || '',
    serialNum: properties['ro.serialno'] || '', kernelVersion,
    processor: properties['ro.soc.model'] || properties['ro.hardware'] || '',
    osVersion: version ? `Android ${version}${sdk ? ` (API ${sdk})` : ''}` : '',
    physicalResolution: screen.match(/Physical size:\s*(\d+x\d+)/)?.[1] || '',
    ...(Number.isFinite(memTotal) && memTotal > 0 ? { memTotal } : {}),
  }
}
