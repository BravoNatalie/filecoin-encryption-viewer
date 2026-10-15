// The "Encrypted share" label above the card on the folder tree screen, plus the tighter `tree-card`
// padding on #app. #card-label lives in index.html next to #app; every other screen clears both.
const slot = () => (typeof document === 'undefined' ? null : document.getElementById('card-label'))
const card = () => (typeof document === 'undefined' ? null : document.getElementById('app'))

export function setCardLabel(text: string): void {
  const element = slot()
  if (!element) return
  const heading = document.createElement('h1')
  heading.className = 'card-label'
  heading.textContent = text
  element.replaceChildren(heading)
  card()?.classList.add('tree-card')
}

export function clearCardLabel(): void {
  slot()?.replaceChildren()
  card()?.classList.remove('tree-card')
}
