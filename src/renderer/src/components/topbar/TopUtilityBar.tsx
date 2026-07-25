import { Brand } from './Brand'
import { AIAssistantInput } from './AIAssistantInput'
import { UserEnvironmentStatus } from './UserEnvironmentStatus'
import styles from './TopUtilityBar.module.css'

export function TopUtilityBar() {
  return (
    <header className={styles.bar}>
      <Brand />
      <AIAssistantInput />
      <UserEnvironmentStatus />
    </header>
  )
}
