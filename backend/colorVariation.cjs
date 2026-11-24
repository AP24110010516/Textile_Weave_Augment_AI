const fabricCharacteristics = {
  Cotton: 'natural cotton fibers with a soft, breathable, mostly matte surface and a visible cotton weave',
  Silk: 'fine, smooth continuous-filament fibers, a refined weave, fluid folds, and a subtle natural silk sheen',
  Denim: 'dense cotton denim with a characteristic diagonal twill weave, visible diagonal ribs, and a sturdy textured surface',
  Wool: 'natural crimped wool fibers with a soft, slightly fuzzy surface and a warm, textured woven or knitted structure',
  Polyester: 'fine, regular synthetic filaments with a smooth, resilient surface and the subtle sheen characteristic of polyester',
}

function normalizeFabricType(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new TypeError('Fabric type must be text.')

  const fabricType = Object.keys(fabricCharacteristics).find((type) => type.toLowerCase() === value.trim().toLowerCase())
  if (!fabricType && value.trim()) {
    throw new RangeError(`Unsupported fabric type. Choose ${Object.keys(fabricCharacteristics).join(', ')}.`)
  }
  return fabricType || ''
}

function buildTextilePrompt(basePrompt, fabricType) {
  if (!fabricType) return basePrompt
  const characteristics = fabricCharacteristics[fabricType]
  return `The final textile must be unmistakably ${fabricType}: ${characteristics}. If the source differs, transform its fiber appearance and weave to match ${fabricType}; do not retain a conflicting material type. Preserve the source framing, folds, lighting, shadows, and fine details while keeping the selected ${fabricType} identity throughout. ${basePrompt}`.trim()
}

function mapDatasetImageStrength(uiStrength) {
  // Calibrate the UI range to SDXL strengths that retain most of the source image.
  return Number((uiStrength + 0.45).toFixed(2))
}

function normalizeDesiredFabricColor(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new TypeError('Desired fabric color must be text.')

  const color = value.trim().replace(/\s+/g, ' ')
  if (color.length > 40 || (color && !/^[a-z][a-z -]*$/i.test(color))) {
    throw new RangeError('Enter a color name using letters, spaces, or hyphens (up to 40 characters).')
  }
  return color
}

function buildColorVariationPrompt(basePrompt, desiredFabricColor) {
  const colorInstruction = desiredFabricColor
    ? `Re-dye the fabric in the supplied image to ${desiredFabricColor}. The requested color must be visible in the textile fibers and yarns themselves, not as colored lighting, a background change, or a transparent overlay. Change the fabric color only; retain the same material, weave, texture, folds, shadows, and fine details.`
    : 'Create a natural color variation of the fabric in the supplied image. Select a plausible fabric color freely for this generated sample, and make the fabric color visibly different from the source. Do not retain the source color and do not favor any fixed or default color. Preserve the same material, weave, texture, folds, shadows, and fine details.'

  return `${colorInstruction} ${basePrompt}`.trim()
}

module.exports = {
  buildColorVariationPrompt,
  buildTextilePrompt,
  mapDatasetImageStrength,
  normalizeDesiredFabricColor,
  normalizeFabricType,
}
