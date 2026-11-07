# Skutočné odpojenie uzla od siete "cluster" (Docker network disconnect).
# Uzol ďalej beží so svojou DB, len nevidí ostatné uzly.
#
#   .\scripts\partition.ps1 -Node b -Action disconnect
#   .\scripts\partition.ps1 -Node b -Action connect
param(
  [Parameter(Mandatory)][ValidateSet("a", "b", "c")][string]$Node,
  [Parameter(Mandatory)][ValidateSet("disconnect", "connect")][string]$Action
)

$network = "gatesync_cluster"
foreach ($svc in @("api-$Node", "worker-$Node")) {
  $container = "gatesync-$svc-1"
  if ($Action -eq "disconnect") {
    docker network disconnect $network $container
  } else {
    docker network connect --alias $svc $network $container
  }
  Write-Host "$Action $container ($network)"
}
