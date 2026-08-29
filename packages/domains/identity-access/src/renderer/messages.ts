export const identityI18nResourceContribution = Object.freeze({
  namespace: 'identity',
  resources: Object.freeze({
    en: Object.freeze({
      accountTitle: 'SciForge Account',
      accountNotice: 'Sign in with your SciForge Cloud account and manage this Desktop.',
      close: 'Close',
      loading: 'Loading...',
      cloudTitle: 'SciForge Cloud',
      cloudNotice: 'Secure system-browser sign-in establishes the current SciForge identity.',
      cloudLoading: 'Loading cloud identity...',
      cloudSignedOut: 'Not signed in to SciForge Cloud',
      cloudSignIn: 'Sign in with browser',
      cloudSignOut: 'Sign out',
      cloudReauthenticate: 'Reauthenticate',
      cloudEnrollDevice: 'Register this Desktop',
      cloudRevokeDevice: 'Revoke this Desktop',
      cloudDeviceActive: 'This Desktop is connected',
      cloudDeviceRevoked: 'This Desktop is revoked',
      cloudDeviceEnrolling: 'Registering this Desktop',
      cloudDeviceNotEnrolled: 'This Desktop is not connected',
      cloudDeviceError: 'Desktop registration needs attention'
    }),
    zh: Object.freeze({
      accountTitle: 'SciForge 账户',
      accountNotice: '登录 SciForge 云端账户并管理这台 Desktop。',
      close: '关闭',
      loading: '加载中...',
      cloudTitle: 'SciForge 云端',
      cloudNotice: '通过系统浏览器安全登录，建立当前 SciForge 身份。',
      cloudLoading: '正在加载云端身份...',
      cloudSignedOut: '尚未登录 SciForge 云端',
      cloudSignIn: '使用浏览器登录',
      cloudSignOut: '退出云端登录',
      cloudReauthenticate: '重新认证',
      cloudEnrollDevice: '注册这台 Desktop',
      cloudRevokeDevice: '撤销这台 Desktop',
      cloudDeviceActive: '此 Desktop 已连接',
      cloudDeviceRevoked: '此 Desktop 已撤销',
      cloudDeviceEnrolling: '正在注册此 Desktop',
      cloudDeviceNotEnrolled: '此 Desktop 尚未连接',
      cloudDeviceError: 'Desktop 注册需要处理'
    })
  })
})

export type IdentityI18nResourceContribution = typeof identityI18nResourceContribution
