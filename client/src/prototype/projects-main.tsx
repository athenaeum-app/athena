// PROTOTYPE, throwaway. Entry for prototype-projects.html; mounts the Projects
// board prototype with the real stylesheet and the app's default theme/look so
// the variants are judged in Athena's skin, not a vacuum.
import { render } from 'solid-js/web'
import '../index.css'
import { ProjectsPrototype } from './ProjectsPrototype'

document.documentElement.setAttribute('data-theme', 'dark')
document.documentElement.setAttribute('data-look', 'legacy')

render(() => <ProjectsPrototype />, document.getElementById('root')!)
