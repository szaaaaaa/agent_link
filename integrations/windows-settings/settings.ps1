param([string]$Node, [string]$Launcher, [string]$Shortcut)
$ErrorActionPreference = 'Stop'
$arguments = '-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "{0}" -Node "{1}" -Launcher "{2}"' -f $PSCommandPath, $Node, $Launcher
if ($Shortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($Shortcut)
    $target = (Join-Path $PSHOME 'powershell.exe')
    if (Test-Path -LiteralPath $Shortcut) {
        if ($link.TargetPath -ne $target -or !$link.Arguments.EndsWith(('-Launcher "{0}"' -f $Launcher), [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to overwrite a different shortcut: $Shortcut"
        }
        if ($link.Arguments -eq $arguments) { return }
    }
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Shortcut))
    $link.TargetPath = $target
    $link.Arguments = $arguments
    $link.Description = 'Agent Link workspace sharing settings'
    $link.Save()
    return
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = 'Agent Link · 共享设置'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = [Drawing.Size]::new(740, 555)
$form.MinimumSize = [Drawing.Size]::new(620, 470)
$form.AutoScaleMode = 'Dpi'
$form.Font = [Drawing.Font]::new('Microsoft YaHei UI', 9)
$layout = New-Object Windows.Forms.TableLayoutPanel
$layout.Dock = 'Fill'
$layout.Padding = [Windows.Forms.Padding]::new(16)
$layout.ColumnCount = 1
$layout.RowCount = 7
foreach ($row in @(@('Absolute', 37), @('Absolute', 42), @('Percent', 38), @('Absolute', 32), @('Percent', 62), @('Absolute', 44), @('Absolute', 24))) {
    $null = $layout.RowStyles.Add([Windows.Forms.RowStyle]::new([Windows.Forms.SizeType]$row[0], $row[1]))
}
$form.Controls.Add($layout)

function Add-Label($text, $row) {
    $label = New-Object Windows.Forms.Label
    $label.Text = $text
    $label.Dock = 'Fill'
    $label.TextAlign = 'MiddleLeft'
    $layout.Controls.Add($label, 0, $row)
    return $label
}
function Add-List($row, $columns) {
    $list = New-Object Windows.Forms.ListView
    $list.View = 'Details'
    $list.Dock = 'Fill'
    $list.FullRowSelect = $true
    $list.HideSelection = $false
    $list.MultiSelect = $false
    foreach ($column in $columns) { $null = $list.Columns.Add($column[0], $column[1]) }
    $layout.Controls.Add($list, 0, $row)
    return $list
}
$heading = Add-Label '工作区共享' 0
$heading.Font = [Drawing.Font]::new($form.Font.FontFamily, 16, [Drawing.FontStyle]::Bold)
$toolbar = New-Object Windows.Forms.FlowLayoutPanel
$toolbar.Dock = 'Fill'
$layout.Controls.Add($toolbar, 0, 1)
function Add-Button($caption) {
    $button = New-Object Windows.Forms.Button
    $button.Text = $caption
    $button.AutoSize = $true
    $button.Height = 32
    $toolbar.Controls.Add($button)
    return $button
}
$add = Add-Button '选择并共享文件夹…'
$remove = Add-Button '停止共享'
$refresh = Add-Button '刷新'
$workspaces = Add-List 2 @(,@('共享中的工作区', 660))
$workspaces.AccessibleName = '共享中的工作区'
$null = Add-Label '共享会话' 3
$threads = Add-List 4 @(@('会话', 260), @('工作区', 145), @('Pi', 68), @('Codex', 84), @('状态', 103))
$threads.AccessibleName = '共享会话'
$null = Add-Label '在 Pi Desktop 或 Codex 打开同一工作区查看会话。若列表未更新，请重新打开该项目或客户端。' 5
$status = Add-Label '正在连接 Agent Link…' 6
$status.AutoEllipsis = $true

$script:job = $null
$script:modal = $false
$script:nextRefresh = [DateTime]::MaxValue
$script:lastStatus = $null
function Update-Buttons {
    $idle = ($null -eq $script:job)
    $add.Enabled = $idle
    $remove.Enabled = $idle -and $workspaces.SelectedItems.Count -eq 1
    $refresh.Enabled = $idle
}
function Start-Request($command, $path) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Node
    $info.Arguments = '"{0}" {1}' -f $Launcher, $command
    if ($path) { $info.Arguments += ' "' + ($path -replace '(\\+)$', '$1$1') + '"' }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    try {
        $child = [Diagnostics.Process]::Start($info)
        $script:job = @{ Child = $child; Out = $child.StandardOutput.ReadToEndAsync(); Err = $child.StandardError.ReadToEndAsync(); Command = $command }
        Update-Buttons
    } catch {
        $script:lastStatus = $null
        $status.Text = $_.Exception.Message
        $script:nextRefresh = [DateTime]::MaxValue
    }
}
function Update-Lists($data) {
    $selected = if ($workspaces.SelectedItems.Count) { $workspaces.SelectedItems[0].Tag }
    $workspaces.BeginUpdate()
    $threads.BeginUpdate()
    try {
        $workspaces.Items.Clear()
        $threads.Items.Clear()
        $paths = @{}
        foreach ($workspace in $data.workspaces) {
            $paths[$workspace.workspace_key] = $workspace.raw_path
            $item = $workspaces.Items.Add($workspace.raw_path)
            $item.Tag = $workspace.workspace_key
            if ($item.Tag -eq $selected) { $item.Selected = $true }
        }
        foreach ($thread in $data.threads) {
            $item = $threads.Items.Add($thread.title)
            $null = $item.SubItems.Add([string]$paths[$thread.workspace_key])
            foreach ($agent in @('pi', 'codex')) {
                $binding = $thread.bindings | Where-Object agent -eq $agent | Select-Object -First 1
                $text = if (!$binding -or $binding.mirror_pending) { '待同步' }
                    elseif ($binding.native_notice) { '待索引' } else { '已登记' }
                $null = $item.SubItems.Add($text)
            }
            $label = switch ($thread.status) { 'DIVERGED' { '已分叉' } 'CIRCUIT_OPEN' { '已暂停' } default { '同步中' } }
            $null = $item.SubItems.Add($label)
        }
    } finally {
        $workspaces.EndUpdate()
        $threads.EndUpdate()
    }
    $status.Text = if (!$workspaces.Items.Count) { '选择一个工作区开始共享。' }
        else { '{0} 个共享工作区 · {1} 个会话' -f $workspaces.Items.Count, $threads.Items.Count }
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    if ($script:modal) { return }
    if ($script:job -and $script:job.Child.HasExited -and $script:job.Out.IsCompleted -and $script:job.Err.IsCompleted) {
        $finished = $script:job
        $script:job = $null
        try {
            if ($finished.Child.ExitCode -ne 0) { throw $finished.Err.Result.Trim() }
            if ($finished.Command -eq 'status') {
                if ($finished.Out.Result -cne $script:lastStatus) {
                    Update-Lists ($finished.Out.Result | ConvertFrom-Json)
                    $script:lastStatus = $finished.Out.Result
                }
                $script:nextRefresh = [DateTime]::Now.AddSeconds(3)
            } else { Start-Request 'status' }
        } catch {
            $script:lastStatus = $null
            $status.Text = '操作失败：' + $_.Exception.Message
            $script:nextRefresh = [DateTime]::MaxValue
        } finally {
            $finished.Child.Dispose()
            Update-Buttons
        }
    } elseif (!$script:job -and [DateTime]::Now -ge $script:nextRefresh) {
        Start-Request 'status'
    }
})
$workspaces.Add_SelectedIndexChanged({ Update-Buttons })
$refresh.Add_Click({ Start-Request 'status' })
$add.Add_Click({
    $script:modal = $true
    $picker = New-Object Windows.Forms.FolderBrowserDialog
    $picker.Description = '选择要共享会话的工作区文件夹'
    $picker.ShowNewFolderButton = $false
    try {
        if ($picker.ShowDialog($form) -eq 'OK' -and [Windows.Forms.MessageBox]::Show($form,
            "启用后，此目录中已有和新建的会话问答将复制到本机其他受支持客户端的历史记录。请选择你愿意共享的工作区。`n`n$($picker.SelectedPath)",
            '确认共享', 'OKCancel', 'Warning') -eq 'OK') { Start-Request 'watch' $picker.SelectedPath }
    } finally { $picker.Dispose(); $script:modal = $false }
})
$remove.Add_Click({
    $script:modal = $true
    try {
        $path = $workspaces.SelectedItems[0].Text
        if ([Windows.Forms.MessageBox]::Show($form, "停止后不会继续同步。已经复制到客户端的会话不会被删除。`n`n$path",
                '停止共享', 'OKCancel', 'Warning') -eq 'OK') { Start-Request 'unwatch' $path }
    } finally { $script:modal = $false }
})
$form.Add_Shown({ Start-Request 'status'; $timer.Start() })
try { $null = $form.ShowDialog() }
finally {
    $timer.Dispose()
    if ($script:job) { $script:job.Child.Dispose() }
    $form.Dispose()
}
