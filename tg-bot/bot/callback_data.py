"""Callback-data prefix constants. Kept here so keyboards.py and the callback
handlers can't drift apart on the wire-format strings."""

CB_WINDOW = "window"          # window:<instance_key>
CB_APPROVE = "approve"        # approve:<id>:<once|always|deny>
CB_ASK = "ask"                # ask:<id>:<option_idx>
CB_PLAN = "plan"              # plan:<id>:<apply|decline>
CB_REPLY_TO = "reply_to"      # reply_to:<instance_key>
CB_PERM = "perm"              # perm:list | perm:show:<ws> | perm:set:<ws>:<ask|bypass>
CB_WSTATUS = "wstatus"        # wstatus:list | wstatus:show:<instance_key> | wstatus:switch:<instance_key>
CB_SETTINGS = "settings"      # settings:root | settings:perm | settings:defwin | settings:setdef:<instance_key>
CB_LAUNCH = "launch"          # launch:list | launch:go:<workspace_name>
CB_EFFORT = "effort"          # effort:<low|medium|high|max>
CB_EXIT = "exit"              # exit:go | exit:cancel
CB_RESTART = "restart"        # restart:go | restart:cancel
CB_UPDATE = "update"          # update:<cb_token(machine label)> | update:all
CB_MODEL = "model"            # model:<alias>  (alias e.g. opus[1m], sonnet, fable)
