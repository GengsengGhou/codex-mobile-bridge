import { BridgeError } from './desktop.mjs';

// Read the host matrix advertised by the installed tool schema. Fail closed on format changes.
export function advertisedModels(tool) {
  const properties = tool?.inputSchema?.properties;
  if (!properties?.model || !Array.isArray(properties.thinking?.enum)) return [];
  const description = properties.model.description ?? '';
  const marker = 'Models and supported reasoning efforts on the calling host: ';
  if (!description.includes(marker)) return [];
  const models = [];
  for (const match of description.slice(description.indexOf(marker) + marker.length).matchAll(/([a-zA-Z0-9][a-zA-Z0-9._+-]*) \(([^()]*)supported reasoning efforts: ([a-z, ]+)\)/g)) {
    const efforts = match[3].split(',').map(value => value.trim());
    if (efforts.length && efforts.every(value => properties.thinking.enum.includes(value)) && !models.some(model => model.id === match[1])) models.push({ id: match[1], efforts });
  }
  return models;
}

export function modelSelection(body) {
  const result = {};
  for (const key of ['model', 'thinking']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'string' || !body[key] || body[key].length > 128) throw new BridgeError('模型或推理强度参数无效', 'INVALID_REQUEST', 400);
    result[key] = body[key];
  }
  if (result.thinking && !result.model) throw new BridgeError('选择推理强度时请同时选择模型', 'INVALID_REQUEST', 400);
  return result;
}

export function validateModelSelection(selection, models) {
  if (!selection.model) return selection;
  const model = models.find(value => value.id === selection.model);
  if (!model || selection.thinking && !model.efforts.includes(selection.thinking)) throw new BridgeError('所选模型或推理强度当前不可用，请重新选择', 'MODEL_UNAVAILABLE', 409);
  return selection;
}
