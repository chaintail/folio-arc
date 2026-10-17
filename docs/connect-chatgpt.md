# Connect ChatGPT to Folio Paper

The hosted connection at **https://chatgpt.tryfolio.io** serves Folio Paper. You do not need a second hostname or Privy account. These instructions describe the hosted integration; the local connector contains isolated portfolios.

## Already connected

1. Open the Paper version of Folio and sign in once to initialize your account.
2. In ChatGPT, reconnect your existing Folio connection if prompted. Sign in with the same Google account as Folio.
3. In a chat, select Folio and ask it to read your portfolio or save a research report. Saved reports belong to the Paper environment.

## New connection

1. Open plugins/apps and click **+** to create a connection.
2. Enter **Folio** and **https://chatgpt.tryfolio.io**.
3. Open **Advanced settings**.
4. In **BaseScopes**, add `openid` and `offline_access`, each on its own line, then save.

Authorization starts when you use Folio in a chat. This connection is Paper-only; changing the app environment does not change its routing. Existing Live authorization state was not copied into Paper, so reconnecting can be required.

Review the requested scopes and renewable-access consent before authorizing. Browser logout does not disconnect ChatGPT access.
