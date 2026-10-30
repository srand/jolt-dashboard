import ArticleIcon from "@mui/icons-material/Article";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";


const LogButton = ({ onClick, disabled, label = 'View log' }) => {
    return (
        <FormControlLabel
            sx={{ ml: 0, mr: 0 }}
            disabled={disabled}
            control={
                <IconButton onClick={onClick} aria-label={label}>
                    <ArticleIcon />
                </IconButton>
            }
        />
    );
};


export default LogButton;
