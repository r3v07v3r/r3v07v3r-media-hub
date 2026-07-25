import { Icon } from '@renderer/components/icons/Icon'
import styles from './CompactAIAssistant.module.css'

export function AssistantStatus() {
  return (
    <p className={styles.statusLine}>
      <Icon name="waveform" />
      Ready when you are.
    </p>
  )
}
