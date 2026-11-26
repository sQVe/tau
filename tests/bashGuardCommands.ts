export const nohupClose =
  'nohup sh -c \'sleep 30; herdr-app do space.close --id sp527dd22aa065042833adf82c857c6cab --confirmed\' >/dev/null 2>&1 & echo "close scheduled"';

export const loggedClose =
  "setsid sh -c 'sleep 25; herdr-app do space.close --id sp527dd22aa065042833adf82c857c6cab --confirmed true > /tmp/tau-space-close.log 2>&1' </dev/null >/dev/null 2>&1 &";
