' Luna: запускает супервизора БЕЗ окна консоли (скрыто, в фоне).
' Если супервизор уже работает — новый экземпляр тихо выйдет сам (порт занят).
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "node """ & root & "\tools\supervisor.mjs""", 0, False
