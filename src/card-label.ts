// The "Encrypted share" label above the card on the folder tree and file screens, plus the tighter `label-card`
// padding on #app. #card-label lives in index.html next to #app; every other screen clears both.
// Both also reset the tree view's `tree-card` width class; showProtectedArchive sets it again after setCardLabel.
const slot = () => (typeof document === 'undefined' ? null : document.getElementById('card-label'))
const card = () => (typeof document === 'undefined' ? null : document.getElementById('app'))

export function setCardLabel(text: string): void {
  const element = slot()
  if (!element) return
  const heading = document.createElement('h1')
  heading.className = 'card-label'
  heading.textContent = text
  element.replaceChildren(heading)
  card()?.classList.remove('tree-card')
  card()?.classList.add('label-card')
}

export function clearCardLabel(): void {
  slot()?.replaceChildren()
  card()?.classList.remove('label-card', 'tree-card')
}
