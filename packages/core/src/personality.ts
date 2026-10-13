import { z } from 'zod'

const promptLineSchema = z.string().trim().min(1).max(500)
const promptSectionSchema = z.array(promptLineSchema).min(1).max(12)

/** The only fields a user-supplied personality file may control. */
export const personalityOverrideSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    identity: promptSectionSchema.optional(),
    traits: promptSectionSchema.optional(),
    communicationStyle: promptSectionSchema.optional()
  })
  .strict()

export const responseLengthSchema = z.enum(['concise', 'balanced', 'detailed'])

export const personalityConfigurationSchema = z.object({
  override: personalityOverrideSchema.default({}),
  responseLength: responseLengthSchema.default('balanced'),
  extraInstructions: z.string().trim().min(1).max(4000).optional()
})

export type PersonalityOverride = z.infer<typeof personalityOverrideSchema>
export type ResponseLength = z.infer<typeof responseLengthSchema>
export type PersonalityConfiguration = z.infer<typeof personalityConfigurationSchema>

export interface AlfredPersonality {
  readonly name: string
  readonly identity: readonly string[]
  readonly traits: readonly string[]
  readonly communicationRules: readonly string[]
  /** Application-owned: never derived from personality configuration. */
  readonly currentCapabilities: readonly string[]
  /** Application-owned: never derived from personality configuration. */
  readonly plannedCapabilities: readonly string[]
  /** Application-owned: never derived from personality configuration. */
  readonly constraints: readonly string[]
  readonly responseLength: ResponseLength
  readonly extraInstructions?: string
}

export const defaultPersonality: AlfredPersonality = {
  name: 'ALFRED',
  identity: [
    "You are ALFRED, which stands for Altijd Luisterend, Fikst Rotzooi, En Doet 't.",
    'You are a local personal digital assistant running in the ALFRED application.'
  ],
  traits: [
    'Be calm, direct, helpful, technically competent, natural, and slightly witty when appropriate.',
    'Be honest about limitations and point out relevant mistakes or incorrect assumptions.',
    'Avoid exaggerated humor, theatrical language, forced catchphrases, and repeatedly naming yourself.'
  ],
  communicationRules: [
    'Answer the actual question directly.',
    'Ask for clarification only when genuinely necessary.',
    "Respond in the user's language unless they request a different language.",
    'State uncertainty when appropriate and do not invent facts.',
    'Preserve context within the current conversation without unnecessarily repeating the user request.'
  ],
  currentCapabilities: [
    'You can have a local, session-only text conversation through the ALFRED application.',
    'You can use only the text provided in this conversation and your model knowledge.'
  ],
  plannedCapabilities: [
    'Computer control and operating-system actions.',
    'File access and file management.',
    'Persistent memory between sessions.',
    'Voice input and voice output.',
    'Web access and external services.',
    'Multi-step task execution.'
  ],
  constraints: [
    'Do not claim to have opened applications, modified files, browsed the web, remembered information permanently, or controlled the operating system.',
    'Do not claim to have tools, computer access, network access, or abilities that the application has not provided.',
    'Never state that an action was performed when it was not performed.'
  ],
  responseLength: 'balanced'
}

export function createPersonality(
  configuration: Partial<PersonalityConfiguration> = {}
): AlfredPersonality {
  const normalizedConfiguration = personalityConfigurationSchema.parse(configuration)
  const { override } = normalizedConfiguration

  return {
    ...defaultPersonality,
    ...(override.name === undefined ? {} : { name: override.name }),
    ...(override.identity === undefined ? {} : { identity: override.identity }),
    ...(override.traits === undefined ? {} : { traits: override.traits }),
    ...(override.communicationStyle === undefined
      ? {}
      : { communicationRules: override.communicationStyle }),
    responseLength: normalizedConfiguration.responseLength,
    ...(normalizedConfiguration.extraInstructions === undefined
      ? {}
      : { extraInstructions: normalizedConfiguration.extraInstructions })
  }
}

/** Builds a deterministic system message from personality and application-owned guidance. */
export function buildSystemPrompt(
  personality: AlfredPersonality,
  executableTools: readonly { name: string; description: string }[] = []
): string {
  const sections = [
    formatSection('Identity', [`You are known as ${personality.name}.`, ...personality.identity]),
    formatSection('Personality', personality.traits),
    formatSection('Communication style', [
      ...personality.communicationRules,
      responseLengthInstruction(personality.responseLength)
    ]),
    formatSection('Current capabilities', personality.currentCapabilities),
    ...(executableTools.length === 0
      ? []
      : [
          formatSection(
            'Currently executable tools',
            executableTools.map((tool) => `${tool.name}: ${tool.description}`)
          )
        ]),
    formatSection('Planned capabilities (NOT available yet)', personality.plannedCapabilities),
    formatSection('Behavioral constraints', personality.constraints)
  ]

  if (personality.extraInstructions !== undefined) {
    sections.push(formatSection('Extra instructions', [personality.extraInstructions]))
  }

  return sections.join('\n\n')
}

function responseLengthInstruction(responseLength: ResponseLength): string {
  const instructions: Record<ResponseLength, string> = {
    concise: 'Keep responses focused and brief unless the user asks for more detail.',
    balanced: 'Match the response length to the request, balancing clarity and useful detail.',
    detailed: 'Provide thorough explanations when useful, while remaining clear and relevant.'
  }
  return instructions[responseLength]
}

function formatSection(title: string, lines: readonly string[]): string {
  return `## ${title}\n${lines.map((line) => `- ${line}`).join('\n')}`
}
