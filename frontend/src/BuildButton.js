import AccountTreeIcon from "@mui/icons-material/AccountTree";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";


const BuildButton = ({ onClick, disabled, label = 'Show build' }) => {
    return (
        <FormControlLabel
            sx={{ ml: 0, mr: 0 }}
            disabled={disabled}
            control={
                <Tooltip title={disabled ? 'The task belongs to no known build' : label}>
                    {/* Disabled buttons don't fire the events that tooltips need */}
                    <span>
                        <IconButton onClick={onClick} disabled={disabled} aria-label={label}>
                            <AccountTreeIcon />
                        </IconButton>
                    </span>
                </Tooltip>
            }
        />
    );
};


export default BuildButton;
