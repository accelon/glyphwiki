# 回報：DSH 沙箱的 Low 完整性標籤在工作區留下永久副作用

> 回報管道：DSH 的 `/feedback`（「发送关于当前会话的反馈」）。
> 本文可直接貼上，或作為附件。
>
> 相關文件：`@deepseek-ai/dsh-sandbox-windows-acl/README.zh.md`
> 〈已知限制與延期工作〉第一條已經承認「診斷保留完整性標籤」，
> 但它**只提到「Low 標籤的可執行檔影響使用者在 DSH 外啟動程序」**——
> 本文補上**具體的下游症狀與可重現步驟**，那些是原文件沒有列的。

## 摘要

DSH 的 Windows ACL 沙箱會把**工作區根目錄**標成 Low 完整性
（`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`）。
這個標記是**永久**的：**即使該會話後來切成「完整權限」也不會被移除**。
結果是**在 DSH 之外、使用者自己的機器上**出現兩個症狀，
而目前隨包發布的 `diagnose-windows-sandbox-acl` 技能**幫不上忙**
（它修的是非預期的權限缺失，而且明文說「診斷保留完整性標籤」）。

## 環境

* Windows 11 家用版中文版（Build 26300）、DSH Desktop 2.0.17
* 工作區 `D:\2023\glyphwiki`（受限模式 `workspace-write` 用過；後來切為完整權限）
* 對照資料夾 `D:\2026\*`（其他會話的工作區，**沒有**這個標籤）
* `SmartScreenEnabled = RequireAdmin`（封鎖級；一般使用者預設是 `Warn`）

## 症狀

**① 從工作區建出的 exe，雙擊被 SmartScreen 擋**

```
「Windows 已保護您的電腦」
「Microsoft Defender SmartScreen 已封鎖無法辨識的應用程式」  只有「確定」
```

**② 該 exe 啟動後寫不進使用者設定目錄**

```
mkdir C:\Users\<user>\AppData\Roaming\<app>: Access is denied.
mkdir C:\Users\<user>\AppData\Local\<app>:    Access is denied.
```

→ 對 WebView2 的應用，這會造成 user data folder 建不出來，接著：

```
[WebView2] Environment created successfully
[WebView2 Error] error creating controller with 800700aa: The requested resource is in use.
```

（錯誤訊息完全指不到真因，且 Wails 會直接 `os.Exit(1)`。）

## 最小重現

```powershell
# 1. 確認工作區被標成 Low
icacls "D:\2023\glyphwiki"
#   D:\2023\glyphwiki  Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)

# 2. 在裡面建一個執行檔（任何 exe 都可以）
Copy-Item C:\Windows\System32\charmap.exe "D:\2023\glyphwiki\x.exe"
icacls "D:\2023\glyphwiki\x.exe"
#   x.exe  Mandatory Label\Low Mandatory Level:(I)(NW)      ← 繼承

# 3. 用檔案總管雙擊 x.exe → SmartScreen 擋下，程式不啟動
#    （同一顆 exe 複製到沒有標籤的資料夾 → 正常啟動）

# 4. 對照：不經 shell 的啟動方式（CreateProcess）不會觸發 SmartScreen，
#    所以自動化測試很容易漏掉這個症狀
```

**同一份位元組、不同資料夾的對照（sha256 完全相同）**：

| 位置 | 完整性標籤 | 雙擊結果 | exe 能寫 `%APPDATA%` 嗎 |
| --- | --- | --- | --- |
| `D:\2023\glyphwiki\...` | Low（繼承） | 被 SmartScreen 擋 | ❌ |
| `D:\app\...` | 無（Medium） | 正常 | ✅ |

## 根因（引用 DSH 自己的文件）

`README.zh.md`〈機制〉：

> 呼叫者權杖被複製為 `WRITE_RESTRICTED` 受限權杖……該權杖還會被降級為 Low 完整性。
> ……每次授權還會向 world SID 拒絕 `FILE_DELETE_CHILD`……**並在同一次
> `SetNamedSecurityInfoW` 呼叫中把該目錄標為 Low。**

同檔〈機制〉又說：

> 工作區 SID 由規範工作區路徑確定性派生（`workspaceWriteSid`），因此工作區根目錄的
> 安全描述符改動**每台機器每個工作區只物化一次**，之後每次會話、呼叫或重啟都命中
> 精確 ACE／精確拒絕／**精確標籤**跳過。

→ 標籤一旦寫上就留著；而「精確標籤跳過」也意味著**手動移除會被下次供給改回來**。

## 為什麼現有技能幫不上忙

`assets/diagnose-windows-sandbox-acl/SKILL.md` 的適用範圍是
「**非預期**的存取拒絕：工作區寫入或列舉失敗、或平常讀得到的路徑讀不到」。
本案是**預期內的**限制（標籤本來就是沙箱的機制），
而且 `README.zh.md`〈已知限制〉第一條自己說：

> **診斷保留完整性標籤**——它無法修復 Low 標籤的可執行檔影響用戶在 DSH 外啟動程序的問題……

**所以這是一條已知但未修的路徑**，而且它的下游症狀（`%APPDATA%` 被拒、
SmartScreen 在 `RequireAdmin` 下沒有「仍執行」、`800700aa`）
比原文件描述的更嚴重——**它會讓使用者以為自己的程式壞了或機器有問題**。

## 建議

1. **在會話離開受限模式時（或工作區不再被沙箱供給時）移除 Low 標籤**——
   或至少提供一個官方清理命令（〈未來：警告與清理表面〉已把它列為未決）。
2. **在 UI 上警告**：工作區被標成 Low 之後，若使用者從該工作區產生執行檔，
   提示「這個檔案在工作區外會被 SmartScreen 擋、且寫不進 `%APPDATA%`」。
3. **在〈已知限制〉補上下游症狀**（`%APPDATA%` 被拒、WebView2 `800700aa`、
   SmartScreen 無「仍執行」），並說明診斷技能在此路徑上無效，
   讓後續遇到的人不必重新查一遍。

## 為什麼值得修（成本估計）

這個症狀的第一現場**完全指不到真因**：錯誤訊息是 `ERROR_BUSY`、
`Access is denied`，而檔案的雜湊、簽章、manifest、版本資源**全都正常**。
實測要排除「檔案本身的性質」需要十餘次實驗
（含把同一份 sha256 放到不同資料夾、自造 MOTW 資料夾驗證偵測方法、
逐一比對子系統／manifest／版本資源／ADS／簽章）。
**一行 `icacls` 就能給出答案，但沒人會想到要去那裡找。**
