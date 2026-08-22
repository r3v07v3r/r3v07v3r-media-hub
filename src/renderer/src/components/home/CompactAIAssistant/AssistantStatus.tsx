import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './CompactAIAssistant.module.css'

/** Says which model is answering, or that none is — the panel shouldn't
 *  read "Ready when you are" when nothing has been connected for it to
 *  ask (see Settings → AI assistant). */
export function AssistantStatus() {
  const { mediaHubSettings } = useAppState()
  const model = mediaHubSettings?.ollamaConnected ? mediaHubSettings.ollamaModel : ''

  return (
    <p className={styles.statusLine}>
      <Icon name="waveform" />
      {model ? `Ready — running ${model} locally.` : 'No local model connected yet.'}
    </p>
  )
}
