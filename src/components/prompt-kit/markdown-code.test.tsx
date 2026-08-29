import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './markdown'

describe('Markdown fenced code blocks', () => {
  it('renders bash fences with language class from the code component', () => {
    const html = renderToStaticMarkup(
      <Markdown>{'```bash\ndocker exec -it x\n```'}</Markdown>,
    )
    expect(html).toContain('Bash')
    expect(html).not.toContain('Plain Text')
  })

  it('infers bash for unlabeled CLI usage fences', () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {['```', 'Usage: acompile [options]', '  --onnx=<path>', '```'].join(
          '\n',
        )}
      </Markdown>,
    )
    expect(html).toContain('Bash')
  })
})
