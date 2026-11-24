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

module.exports = { buildColorVariationPrompt, normalizeDesiredFabricColor }
