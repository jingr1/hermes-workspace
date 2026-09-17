export type AgoraxManagedImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'

export type AgoraxManagedPromptContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      mimeType: AgoraxManagedImageMimeType
      data: string
      attachmentId: string
      name: string
    }

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/

export function managedPromptContentFromAttachments(input: {
  text: string
  attachments: Array<{
    id?: unknown
    name?: unknown
    contentType?: unknown
    dataUrl?: unknown
  }>
}): Array<AgoraxManagedPromptContentBlock> {
  const content: Array<AgoraxManagedPromptContentBlock> = [
    { type: 'text', text: input.text },
  ]
  for (const attachment of input.attachments) {
    const dataUrl = typeof attachment.dataUrl === 'string' ? attachment.dataUrl : ''
    const match = IMAGE_DATA_URL.exec(dataUrl)
    const id = typeof attachment.id === 'string' ? attachment.id.trim() : ''
    const name = typeof attachment.name === 'string' ? attachment.name.trim() : ''
    const contentType = typeof attachment.contentType === 'string' ? attachment.contentType : ''
    if (!match || !id || !name || match[1] !== contentType) {
      throw new Error('Managed Agent supports only readable image attachments')
    }
    content.push({
      type: 'image',
      mimeType: match[1] as AgoraxManagedImageMimeType,
      data: match[2],
      attachmentId: id,
      name,
    })
  }
  return content
}