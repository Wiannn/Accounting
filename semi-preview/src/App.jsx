import { useState } from 'react'
import { Button, Card, Input, Modal, Tag, Toast } from '@douyinfe/semi-ui'
import { IconPlus, IconRefresh, IconTickCircle } from '@douyinfe/semi-icons'

export default function App() {
  const [text, setText] = useState('')
  const [count, setCount] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)

  const reset = () => {
    setText('')
    setCount(0)
  }

  const confirmModal = () => {
    setModalOpen(false)
    Toast.success({ content: 'Semi Design 弹窗交互正常' })
  }

  return (
    <div className="semi-preview-page">
      <main className="semi-preview-shell">
        <header className="semi-preview-header">
          <span className="semi-preview-eyebrow">COMPONENT PLAYGROUND</span>
          <h1>Semi Design 独立试用</h1>
          <p>Vite + React 已接入 Semi Design，可在这里验证组件效果。</p>
        </header>

        <Card className="semi-preview-card" bordered={false}>
          <div className="semi-preview-status">
            <Tag color="green" size="large">
              <IconTickCircle />
              组件、样式与图标已加载
            </Tag>
            <span>Semi UI 2.105</span>
          </div>

          <section className="semi-preview-counter" aria-live="polite">
            <span>内存计数</span>
            <strong>{count}</strong>
          </section>

          <label className="semi-preview-field">
            <span>输入演示</span>
            <Input
              value={text}
              onChange={setText}
              placeholder="输入一些文字"
              showClear
              size="large"
            />
          </label>
          <p className="semi-preview-value">当前输入：{text || '尚未输入'}</p>

          <div className="semi-preview-actions">
            <Button
              type="primary"
              theme="solid"
              size="large"
              icon={<IconPlus />}
              onClick={() => setCount(value => value + 1)}
            >
              增加计数
            </Button>
            <Button size="large" icon={<IconRefresh />} onClick={reset}>
              重置
            </Button>
            <Button size="large" type="primary" onClick={() => setModalOpen(true)}>
              打开弹窗
            </Button>
          </div>
        </Card>

        <p className="semi-preview-notice">
          本页面仅为 Semi Design 本地试用，不连接、不读取、不迁移公司账本数据。
        </p>
      </main>

      <Modal
        title="确认演示操作"
        visible={modalOpen}
        onOk={confirmModal}
        onCancel={() => setModalOpen(false)}
        okText="确认"
        cancelText="取消"
        centered
      >
        <p>这个弹窗仅用于验证 Semi Design 的组件与反馈效果，不会保存任何数据。</p>
      </Modal>
    </div>
  )
}
